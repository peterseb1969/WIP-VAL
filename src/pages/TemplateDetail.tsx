import { Fragment, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

// ─── Types ────────────────────────────────────────────────────────────────────

type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'email' | 'url' | 'term'

interface TemplateData {
  name: string
  description?: string
  field_count?: number
  created_by?: string
  source_file?: string
  wip_template_id?: string | null
  wip_template_value?: string | null
  format?: string | null
}

interface TemplateDoc {
  document_id: string
  data: TemplateData
  created_at: string
  version: number
}

interface WipField {
  name: string
  label: string
  type: string
  mandatory: boolean
  terminology_ref?: string
  semantic_type?: string
  validation?: { pattern?: string; minimum?: number; maximum?: number }
  metadata?: Record<string, unknown>
}

interface LegacyColumnData {
  column_name: string
  display_name?: string
  column_index: number
  column_type: FieldType
  required?: boolean
  description?: string
  pattern?: string
  min_value?: number
  max_value?: number
  lov_terminology?: string
}

interface LegacyColumnDoc {
  document_id: string
  data: LegacyColumnData
}

interface DetailResponseNew {
  template: TemplateDoc
  fields: WipField[]
  identityFields: string[]
  wipTemplateVersion: number
}

interface DetailResponseLegacy {
  template: TemplateDoc
  columns: LegacyColumnDoc[]
}

type DetailResponse = DetailResponseNew | DetailResponseLegacy

function isNewResponse(r: DetailResponse): r is DetailResponseNew {
  return 'fields' in r
}

// ─── Export (template → Excel) ─────────────────────────────────────────────────

interface ExportNote {
  field?: string
  feature: string
  severity: 'lossy' | 'blocking'
  action: 'degraded' | 'skipped'
  detail: string
}

interface PreflightResp {
  hardRefused: boolean
  hardRefuseReason?: string
  blocking: ExportNote[]
  lossy: ExportNote[]
  skipFields: string[]
}

const BASE_PATH = import.meta.env.BASE_URL || '/'

// ─── Editable field state ────────────────────────────────────────────────────

interface EditableField {
  name: string
  label: string
  type: FieldType
  mandatory: boolean
  isLov: boolean
  isIdentity: boolean
  metadata?: Record<string, unknown>
  dirty: boolean
}

const NON_LOV_TYPES: { value: FieldType; label: string }[] = [
  { value: 'string',   label: 'String' },
  { value: 'number',   label: 'Number' },
  { value: 'integer',  label: 'Integer' },
  { value: 'boolean',  label: 'Boolean' },
  { value: 'date',     label: 'Date' },
  { value: 'datetime', label: 'Date+Time' },
  { value: 'email',    label: 'Email' },
  { value: 'url',      label: 'URL' },
]

function wipFieldToEditable(field: WipField, identityFields: string[]): EditableField {
  const effectiveType = (field.semantic_type || field.type) as FieldType
  return {
    name: field.name,
    label: field.label,
    type: effectiveType,
    mandatory: field.mandatory,
    isLov: field.type === 'term',
    isIdentity: identityFields.includes(field.name),
    metadata: field.metadata as Record<string, unknown> | undefined,
    dirty: false,
  }
}

function legacyColumnToEditable(col: LegacyColumnDoc): EditableField {
  return {
    name: col.document_id,
    label: col.data.display_name ?? col.data.column_name,
    type: col.data.column_type,
    mandatory: col.data.required ?? false,
    isLov: col.data.column_type === 'term',
    isIdentity: false,
    dirty: false,
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

type Phase = 'loading' | 'ready' | 'saving' | 'error'

export default function TemplateDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [template, setTemplate] = useState<TemplateDoc | null>(null)
  const [fields, setFields] = useState<EditableField[]>([])
  const [isNewPath, setIsNewPath] = useState(false)
  const [wipVersion, setWipVersion] = useState<number | null>(null)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [expandedField, setExpandedField] = useState<string | null>(null)
  const [exportPanel, setExportPanel] = useState<
    null | { loading: boolean; result?: PreflightResp; error?: string }
  >(null)

  useEffect(() => {
    if (!id) return
    fetch(`${BASE_PATH}api/val-templates/${id}`)
      .then(r => r.ok ? r.json() : r.json().then((b: { error: string }) => Promise.reject(b.error)))
      .then((data: DetailResponse) => {
        setTemplate(data.template)
        if (isNewResponse(data)) {
          setFields(data.fields.map(f => wipFieldToEditable(f, data.identityFields)))
          setIsNewPath(true)
          setWipVersion(data.wipTemplateVersion)
        } else {
          setFields(data.columns.map(legacyColumnToEditable))
          setIsNewPath(false)
        }
        setPhase('ready')
      })
      .catch((e: unknown) => {
        setError(typeof e === 'string' ? e : 'Failed to load template')
        setPhase('error')
      })
  }, [id])

  function updateField(name: string, key: 'label' | 'type', value: string) {
    setFields(prev => prev.map(f =>
      f.name === name ? { ...f, [key]: value, dirty: true } : f
    ))
    setSaveSuccess(false)
  }

  async function handleSave() {
    const dirty = fields.filter(f => f.dirty)
    if (dirty.length === 0) return

    setSaveError(null)
    setSaveSuccess(false)
    setPhase('saving')

    try {
      if (isNewPath) {
        const patches = dirty.map(f => ({
          name: f.name,
          type: f.type,
          label: f.label,
          mandatory: f.mandatory,
        }))
        const res = await fetch(`${BASE_PATH}api/val-templates/${id}/fields`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patches),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText })) as { error: string }
          throw new Error(body.error)
        }
      } else {
        const patches = dirty.map(f => ({
          document_id: f.name,
          column_type: f.type,
          display_name: f.label,
        }))
        const res = await fetch(`${BASE_PATH}api/val-templates/${id}/columns`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patches),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText })) as { error: string }
          throw new Error(body.error)
        }
      }
      setFields(prev => prev.map(f => ({ ...f, dirty: false })))
      setSaveSuccess(true)
      setPhase('ready')
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e))
      setPhase('ready')
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete "${template?.data.name}"? This cannot be undone.`)) return
    setDeleting(true)
    try {
      const res = await fetch(`${BASE_PATH}api/val-templates/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText })) as { error: string }
        throw new Error(body.error)
      }
      navigate('/')
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e))
      setDeleting(false)
    }
  }

  async function openExport() {
    const wipId = template?.data.wip_template_id
    if (!wipId) return
    setExportPanel({ loading: true })
    try {
      const res = await fetch(`${BASE_PATH}api/templates/${wipId}/export/preflight`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText })) as { error: string }
        throw new Error(body.error)
      }
      setExportPanel({ loading: false, result: await res.json() as PreflightResp })
    } catch (e: unknown) {
      setExportPanel({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  function exportUrl(mode: 'template' | 'data', force: boolean): string {
    const wipId = template?.data.wip_template_id
    return `${BASE_PATH}api/templates/${wipId}/export?format=vendor&mode=${mode}${force ? '&force=true' : ''}`
  }

  const dirtyCount = fields.filter(f => f.dirty).length

  // ─────────────────────────────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-sm text-text-muted">Loading…</p>
      </div>
    )
  }

  if (phase === 'error' || !template) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="rounded-lg border border-danger/20 bg-danger/5 p-6 max-w-md">
          <p className="text-sm font-medium text-danger">{error ?? 'Template not found'}</p>
          <button onClick={() => navigate('/')} className="mt-4 text-sm text-primary hover:underline">
            ← Back to templates
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">

        {/* Page header */}
        <header className="mb-6 flex items-start justify-between">
          <div>
            <button
              onClick={() => navigate('/')}
              className="mb-1 text-xs text-text-muted hover:text-text transition-colors"
            >
              ← All Templates
            </button>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-text">{template.data.name}</h1>
              {template.data.format && (
                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
                  template.data.format === 'vendor'
                    ? 'bg-purple-100 text-purple-700'
                    : 'bg-blue-100 text-blue-700'
                }`}>
                  {template.data.format}
                </span>
              )}
            </div>
            {template.data.description && (
              <p className="mt-1 text-sm text-text-muted">{template.data.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {saveSuccess && (
              <span className="text-xs text-success font-medium">Changes saved</span>
            )}
            {isNewPath && template.data.wip_template_id && (
              <button
                onClick={openExport}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-text hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                Export to Excel
              </button>
            )}
            <button
              onClick={handleDelete}
              disabled={deleting || phase === 'saving'}
              className="rounded-md border border-danger/40 px-4 py-2 text-sm font-medium text-danger hover:bg-danger/5 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-danger/40"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
            <button
              onClick={handleSave}
              disabled={dirtyCount === 0 || phase === 'saving'}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {phase === 'saving' ? 'Saving…' : dirtyCount > 0 ? `Save ${dirtyCount} change${dirtyCount !== 1 ? 's' : ''}` : 'No changes'}
            </button>
          </div>
        </header>

        {/* Save error */}
        {saveError && (
          <div className="mb-4 rounded-lg border border-danger/20 bg-danger/5 p-4">
            <p className="text-sm font-medium text-danger">{saveError}</p>
          </div>
        )}

        {/* Export panel */}
        {exportPanel && (
          <div className="mb-4 rounded-lg border border-gray-200 bg-surface p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text">Export to Excel (vendor)</h3>
              <button onClick={() => setExportPanel(null)} className="text-xs text-text-muted hover:text-text">✕ Close</button>
            </div>
            {exportPanel.loading && <p className="text-sm text-text-muted">Checking compatibility…</p>}
            {exportPanel.error && <p className="text-sm font-medium text-danger">{exportPanel.error}</p>}
            {exportPanel.result && (exportPanel.result.hardRefused ? (
              <p className="text-sm font-medium text-danger">Cannot export: {exportPanel.result.hardRefuseReason}</p>
            ) : (
              <div className="space-y-3">
                {exportPanel.result.blocking.length > 0 && (
                  <div className="rounded border border-amber-200 bg-amber-50 p-3">
                    <p className="mb-1 text-xs font-semibold text-amber-800">
                      {exportPanel.result.blocking.length} feature(s) can’t be represented in vendor and will be skipped:
                    </p>
                    <ul className="list-disc space-y-0.5 pl-4 text-xs text-amber-800">
                      {exportPanel.result.blocking.map((b, i) => <li key={i}>{b.detail}</li>)}
                    </ul>
                  </div>
                )}
                {exportPanel.result.lossy.length > 0 && (
                  <div className="rounded border border-gray-200 bg-gray-50 p-3">
                    <p className="mb-1 text-xs font-semibold text-text-muted">
                      {exportPanel.result.lossy.length} feature(s) will be degraded:
                    </p>
                    <ul className="list-disc space-y-0.5 pl-4 text-xs text-text-muted">
                      {exportPanel.result.lossy.map((l, i) => <li key={i}>{l.detail}</li>)}
                    </ul>
                  </div>
                )}
                {exportPanel.result.blocking.length === 0 && exportPanel.result.lossy.length === 0 && (
                  <p className="text-xs text-success">Fully representable — clean export.</p>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <a
                    href={exportUrl('template', exportPanel.result.blocking.length > 0)}
                    download
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
                  >
                    {exportPanel.result.blocking.length > 0 ? `Download schema (skip ${exportPanel.result.blocking.length})` : 'Download schema'}
                  </a>
                  <a
                    href={exportUrl('data', exportPanel.result.blocking.length > 0)}
                    download
                    className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-text hover:bg-gray-50"
                  >
                    Download with data
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Metadata card */}
        <div className="mb-6 rounded-lg border border-gray-200 bg-surface p-4 shadow-sm grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-0.5">Fields</p>
            <p className="text-text">{template.data.field_count ?? fields.length}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-0.5">Created</p>
            <p className="text-text">{new Date(template.created_at).toLocaleDateString()}</p>
          </div>
          {template.data.created_by && (
            <div>
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-0.5">Created by</p>
              <p className="text-text truncate">{template.data.created_by}</p>
            </div>
          )}
          {template.data.wip_template_value && (
            <div>
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-0.5">WIP Template</p>
              <p className="font-mono text-xs text-text truncate">{template.data.wip_template_value}</p>
            </div>
          )}
          {wipVersion != null && (
            <div>
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-0.5">Version</p>
              <p className="text-text">v{wipVersion}</p>
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-0.5">Document ID</p>
            <p className="font-mono text-xs text-text-muted truncate">{template.document_id}</p>
          </div>
          {template.data.source_file && (
            <div className="col-span-2 sm:col-span-4">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-0.5">Source file</p>
              <a
                href={`${BASE_PATH}api/val-templates/${template.document_id}/download`}
                download
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
              >
                ↓ Download source spreadsheet
              </a>
            </div>
          )}
        </div>

        {/* Fields table */}
        <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden shadow-sm">
          <div className="border-b border-gray-200 px-4 py-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-text">Fields</h2>
            <span className="text-xs text-text-muted">— type and label are editable; LOV fields are locked</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs text-text-muted uppercase tracking-wide">
                <th className="px-3 py-2 text-left w-10">#</th>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Label</th>
                <th className="px-3 py-2 text-left w-44">Type</th>
                <th className="px-3 py-2 text-center w-16">Req</th>
                {isNewPath && <th className="px-3 py-2 text-center w-10"></th>}
              </tr>
            </thead>
            <tbody>
              {fields.map((field, i) => (
                <Fragment key={field.name}>
                  <tr
                    className={`border-b border-gray-100 last:border-0 hover:bg-gray-50 border-l-4 ${
                      field.dirty ? 'border-l-accent bg-orange-50/30' : 'border-l-transparent'
                    }`}
                  >
                    <td className="px-3 py-2 text-text-muted tabular-nums">{i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs text-text">{field.name}</span>
                        {field.isIdentity && (
                          <span title="Identity field">
                            <svg className="inline w-3.5 h-3.5 text-amber-600" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={field.label}
                        onChange={e => updateField(field.name, 'label', e.target.value)}
                        className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                      />
                    </td>
                    <td className="px-3 py-2">
                      {field.isLov ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          Controlled (LOV)
                        </span>
                      ) : (
                        <select
                          value={field.type}
                          onChange={e => updateField(field.name, 'type', e.target.value)}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                          {NON_LOV_TYPES.map(t => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {field.mandatory ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">Yes</span>
                      ) : (
                        <span className="text-xs text-text-muted">—</span>
                      )}
                    </td>
                    {isNewPath && (
                      <td className="px-3 py-2 text-center">
                        {field.metadata && Object.keys(field.metadata).length > 0 && (
                          <button
                            onClick={() => setExpandedField(expandedField === field.name ? null : field.name)}
                            className="text-xs text-text-muted hover:text-text"
                            title="Show metadata"
                          >
                            {expandedField === field.name ? '▾' : '▸'}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                  {expandedField === field.name && field.metadata && (
                    <tr className="bg-gray-50/50">
                      <td></td>
                      <td colSpan={isNewPath ? 5 : 4} className="px-3 py-2">
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
                          {Object.entries(field.metadata).map(([k, v]) => (
                            v != null && v !== '' && (
                              <div key={k} className="flex gap-2">
                                <span className="text-text-muted font-medium min-w-[100px]">{k.replace(/_/g, ' ')}</span>
                                <span className="text-text truncate">{String(v)}</span>
                              </div>
                            )
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

      </main>
    </div>
  )
}
