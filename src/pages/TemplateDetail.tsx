import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

// ─── Types ────────────────────────────────────────────────────────────────────

type ColumnType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'email' | 'url' | 'term'

interface TemplateData {
  name: string
  description?: string
  column_count?: number
  created_by?: string
  source_file?: string
}

interface TemplateDoc {
  document_id: string
  data: TemplateData
  created_at: string
  version: number
}

interface ColumnData {
  column_name: string
  display_name?: string
  column_index: number
  column_type: ColumnType
  required?: boolean
  description?: string
  pattern?: string
  min_value?: number
  max_value?: number
  lov_terminology?: string
}

interface ColumnDoc {
  document_id: string
  data: ColumnData
}

interface DetailResponse {
  template: TemplateDoc
  columns: ColumnDoc[]
}

// ─── Editable column state ────────────────────────────────────────────────────

interface EditableColumn {
  document_id: string
  columnName: string
  displayName: string
  columnType: ColumnType
  required: boolean
  isLov: boolean        // term type — not editable in this version
  dirty: boolean
}

// Non-LOV types available for editing
const NON_LOV_TYPES: { value: ColumnType; label: string }[] = [
  { value: 'string',   label: 'String' },
  { value: 'number',   label: 'Number' },
  { value: 'integer',  label: 'Integer' },
  { value: 'boolean',  label: 'Boolean' },
  { value: 'date',     label: 'Date' },
  { value: 'datetime', label: 'Date+Time' },
  { value: 'email',    label: 'Email' },
  { value: 'url',      label: 'URL' },
]

function toEditable(col: ColumnDoc): EditableColumn {
  return {
    document_id: col.document_id,
    columnName: col.data.column_name,
    displayName: col.data.display_name ?? col.data.column_name,
    columnType: col.data.column_type,
    required: col.data.required ?? false,
    isLov: col.data.column_type === 'term',
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
  const [columns, setColumns] = useState<EditableColumn[]>([])
  const [saveSuccess, setSaveSuccess] = useState(false)

  useEffect(() => {
    if (!id) return
    fetch(`/api/val-templates/${id}`)
      .then(r => r.ok ? r.json() : r.json().then((b: { error: string }) => Promise.reject(b.error)))
      .then((data: DetailResponse) => {
        setTemplate(data.template)
        setColumns(data.columns.map(toEditable))
        setPhase('ready')
      })
      .catch((e: unknown) => {
        setError(typeof e === 'string' ? e : 'Failed to load template')
        setPhase('error')
      })
  }, [id])

  function updateColumn(docId: string, key: 'displayName' | 'columnType', value: string) {
    setColumns(prev => prev.map(c =>
      c.document_id === docId ? { ...c, [key]: value, dirty: true } : c
    ))
    setSaveSuccess(false)
  }

  async function handleSave() {
    const dirty = columns.filter(c => c.dirty)
    if (dirty.length === 0) return

    setSaveError(null)
    setSaveSuccess(false)
    setPhase('saving')

    const patches = dirty.map(c => ({
      document_id: c.document_id,
      column_type: c.columnType,
      display_name: c.displayName,
    }))

    try {
      const res = await fetch(`/api/val-templates/${id}/columns`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patches),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText })) as { error: string }
        throw new Error(body.error)
      }
      setColumns(prev => prev.map(c => ({ ...c, dirty: false })))
      setSaveSuccess(true)
      setPhase('ready')
    } catch (e: unknown) {
      setSaveError(e instanceof Error ? e.message : String(e))
      setPhase('ready')
    }
  }

  const dirtyCount = columns.filter(c => c.dirty).length

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
            <h1 className="text-2xl font-semibold tracking-tight text-text">{template.data.name}</h1>
            {template.data.description && (
              <p className="mt-1 text-sm text-text-muted">{template.data.description}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {saveSuccess && (
              <span className="text-xs text-success font-medium">Changes saved</span>
            )}
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

        {/* Metadata card */}
        <div className="mb-6 rounded-lg border border-gray-200 bg-surface p-4 shadow-sm grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-0.5">Columns</p>
            <p className="text-text">{template.data.column_count ?? columns.length}</p>
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
          <div>
            <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-0.5">Document ID</p>
            <p className="font-mono text-xs text-text-muted truncate">{template.document_id}</p>
          </div>
          {template.data.source_file && (
            <div className="col-span-2 sm:col-span-4">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wide mb-0.5">Source file</p>
              <p className="font-mono text-xs text-text">{template.data.source_file}</p>
            </div>
          )}
        </div>

        {/* Columns table */}
        <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden shadow-sm">
          <div className="border-b border-gray-200 px-4 py-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-text">Columns</h2>
            <span className="text-xs text-text-muted">— type and display name are editable; LOV columns are locked until a future release</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs text-text-muted uppercase tracking-wide">
                <th className="px-3 py-2 text-left w-10">#</th>
                <th className="px-3 py-2 text-left">Column Name</th>
                <th className="px-3 py-2 text-left">Display Name</th>
                <th className="px-3 py-2 text-left w-44">Type</th>
                <th className="px-3 py-2 text-center w-16">Req</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((col, i) => (
                <tr
                  key={col.document_id}
                  className={`border-b border-gray-100 last:border-0 hover:bg-gray-50 border-l-4 ${
                    col.dirty ? 'border-l-accent bg-orange-50/30' : 'border-l-transparent'
                  }`}
                >
                  <td className="px-3 py-2 text-text-muted tabular-nums">{i + 1}</td>
                  <td className="px-3 py-2 font-mono text-xs text-text">{col.columnName}</td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={col.displayName}
                      onChange={e => updateColumn(col.document_id, 'displayName', e.target.value)}
                      className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                  </td>
                  <td className="px-3 py-2">
                    {col.isLov ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        Controlled (LOV)
                      </span>
                    ) : (
                      <select
                        value={col.columnType}
                        onChange={e => updateColumn(col.document_id, 'columnType', e.target.value)}
                        className="w-full border border-gray-200 rounded px-2 py-1 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/40"
                      >
                        {NON_LOV_TYPES.map(t => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {col.required ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">Yes</span>
                    ) : (
                      <span className="text-xs text-text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

      </main>
    </div>
  )
}
