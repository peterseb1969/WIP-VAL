import { Fragment, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

// ─── Types (mirrored from server/parsed-template.ts) ─────────────────────────

type WipFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'term'
type SemanticType = 'email' | 'url'
type SpreadsheetFormat = 'c02' | 'vendor'

interface ParsedField {
  name: string
  label: string
  type: WipFieldType
  mandatory: boolean
  semanticType?: SemanticType
  pattern?: string
  minimum?: number
  maximum?: number
  terminologyValues?: string[]
  terminologyName?: string
  metadata?: Record<string, unknown>
}

interface ParsedTemplate {
  suggestedName: string
  suggestedValue: string
  description: string
  format: SpreadsheetFormat
  fields: ParsedField[]
  identityFields: string[]
  rowCount: number
  sheets: string[]
  wipFileId?: string
  wipFileWarning?: string
  templateMeta?: Record<string, string>
  datasetMeta?: Record<string, string>
  identifierPattern?: string
  identityWarnings?: string[]
  detectedFormat: SpreadsheetFormat | null
}

// Working copy per field
interface FieldDef {
  index: number
  name: string
  label: string
  type: WipFieldType
  mandatory: boolean
  semanticType?: SemanticType
  pattern: string
  minValue: string
  maxValue: string
  lovText: string
  terminologyName?: string
  metadata?: Record<string, unknown>
  approved: boolean
  expanded: boolean
  isIdentity: boolean
}

interface SaveResult {
  templateDocumentId: string
  wipTemplateId: string
  wipTemplateValue: string
  fieldCount: number
  terminologiesCreated: string[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FIELD_TYPES: { value: WipFieldType; label: string }[] = [
  { value: 'string',   label: 'String' },
  { value: 'number',   label: 'Number' },
  { value: 'integer',  label: 'Integer' },
  { value: 'boolean',  label: 'Boolean' },
  { value: 'date',     label: 'Date' },
  { value: 'datetime', label: 'Date+Time' },
  { value: 'term',     label: 'Controlled (LOV)' },
]

function parsedFieldToDef(f: ParsedField, index: number, identityFields: string[]): FieldDef {
  return {
    index,
    name: f.name,
    label: f.label,
    type: f.type,
    mandatory: f.mandatory,
    semanticType: f.semanticType,
    pattern: f.pattern ?? '',
    minValue: f.minimum != null ? String(f.minimum) : '',
    maxValue: f.maximum != null ? String(f.maximum) : '',
    lovText: f.terminologyValues ? f.terminologyValues.join('\n') : '',
    terminologyName: f.terminologyName,
    metadata: f.metadata,
    approved: false,
    expanded: false,
    isIdentity: identityFields.includes(f.name),
  }
}

function lovLabel(field: FieldDef): string {
  const count = field.lovText.split('\n').filter(l => l.trim() !== '').length
  if (count === 0) return field.terminologyName ? `sheet: ${field.terminologyName}` : 'no values'
  return `${count} value${count !== 1 ? 's' : ''}${field.terminologyName ? ` (${field.terminologyName})` : ''}`
}

function formatBadge(format: SpreadsheetFormat | null): string {
  if (format === 'vendor') return 'Vendor'
  if (format === 'c02') return 'C02'
  return 'Unknown'
}

// ─── Component ────────────────────────────────────────────────────────────────

type Phase = 'idle' | 'uploading' | 'reviewing' | 'saving' | 'saved'

export default function TemplateParser() {
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const [parseResult, setParseResult] = useState<ParsedTemplate | null>(null)
  const [fields, setFields] = useState<FieldDef[]>([])
  const [templateName, setTemplateName] = useState('')
  const [templateDesc, setTemplateDesc] = useState('')

  const [saveResult, setSaveResult] = useState<SaveResult | null>(null)

  // ── Upload ──────────────────────────────────────────────────────────────────

  async function handleFile(file: File) {
    setError(null)
    setPhase('uploading')
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch('/api/template-parser/upload', { method: 'POST', body: fd })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }
      const result: ParsedTemplate = await res.json()
      setParseResult(result)
      setTemplateName(result.suggestedName)
      setTemplateDesc(result.description)
      setFields(result.fields.map((f, i) => parsedFieldToDef(f, i, result.identityFields)))
      setPhase('reviewing')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('idle')
    }
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    e.target.value = ''
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  // ── Field editing ──────────────────────────────────────────────────────────

  function updateField<K extends keyof FieldDef>(idx: number, key: K, value: FieldDef[K]) {
    setFields(prev => prev.map(f =>
      f.index === idx ? { ...f, [key]: value, approved: false } : f
    ))
  }

  function toggleApprove(idx: number) {
    setFields(prev => prev.map(f =>
      f.index === idx ? { ...f, approved: !f.approved } : f
    ))
  }

  function toggleExpand(idx: number) {
    setFields(prev => prev.map(f =>
      f.index === idx ? { ...f, expanded: !f.expanded } : f
    ))
  }

  function toggleIdentity(idx: number) {
    if (parseResult?.format === 'vendor') return
    setFields(prev => prev.map(f =>
      f.index === idx ? { ...f, isIdentity: !f.isIdentity } : f
    ))
  }

  function approveAll() {
    setFields(prev => prev.map(f => ({ ...f, approved: true })))
  }

  function unapproveAll() {
    setFields(prev => prev.map(f => ({ ...f, approved: false })))
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!allApproved) return
    setError(null)
    setPhase('saving')

    const payload = {
      name: templateName,
      description: templateDesc,
      format: parseResult?.format ?? 'c02',
      wipFileId: parseResult?.wipFileId,
      templateMeta: parseResult?.templateMeta,
      datasetMeta: parseResult?.datasetMeta,
      identifierPattern: parseResult?.identifierPattern,
      identityFields: fields.filter(f => f.isIdentity).map(f => f.name),
      fields: fields.map(f => ({
        name: f.name,
        label: f.label,
        type: f.type,
        mandatory: f.mandatory,
        semanticType: f.semanticType,
        pattern: f.pattern || undefined,
        minimum: f.minValue !== '' ? Number(f.minValue) : undefined,
        maximum: f.maxValue !== '' ? Number(f.maxValue) : undefined,
        terminologyValues: f.type === 'term'
          ? f.lovText.split('\n').map(l => l.trim()).filter(l => l !== '')
          : undefined,
        terminologyName: f.terminologyName,
        metadata: f.metadata,
      })),
    }

    try {
      const res = await fetch('/api/template-parser/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(body.error || res.statusText)
      }
      const result: SaveResult = await res.json()
      setSaveResult(result)
      setPhase('saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('reviewing')
    }
  }

  function reset() {
    setPhase('idle')
    setParseResult(null)
    setFields([])
    setTemplateName('')
    setTemplateDesc('')
    setSaveResult(null)
    setError(null)
  }

  // ── Derived ─────────────────────────────────────────────────────────────────

  const approvedCount = fields.filter(f => f.approved).length
  const allApproved = fields.length > 0 && approvedCount === fields.length
  const identityCount = fields.filter(f => f.isIdentity).length

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">

      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6">

        {/* ── Idle / Upload ─────────────────────────────────────────────────── */}
        {(phase === 'idle' || phase === 'uploading') && (
          <div className="flex flex-col items-center justify-center min-h-[60vh]">
            {error && (
              <div className="mb-6 rounded-lg border border-danger/20 bg-danger/5 p-4 max-w-md w-full text-center">
                <p className="text-sm font-medium text-danger">{error}</p>
              </div>
            )}
            <div
              ref={dropRef}
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileRef.current?.click()}
              className={`
                w-full max-w-lg border-2 border-dashed rounded-lg p-12
                flex flex-col items-center gap-4 cursor-pointer
                transition-colors
                ${dragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-gray-300 hover:border-primary hover:bg-gray-50'
                }
              `}
            >
              <div className="text-4xl">📄</div>
              {phase === 'uploading' ? (
                <p className="text-text-muted text-sm">Parsing spreadsheet…</p>
              ) : (
                <>
                  <p className="text-text font-medium">Drop a spreadsheet here</p>
                  <p className="text-text-muted text-sm">or click to browse — .xlsx, .xls, .csv</p>
                </>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={onFileInput}
            />
          </div>
        )}

        {/* ── Review ────────────────────────────────────────────────────────── */}
        {(phase === 'reviewing' || phase === 'saving') && parseResult && (
          <>
            {error && (
              <div className="mb-4 rounded-lg border border-danger/20 bg-danger/5 p-4">
                <p className="text-sm font-medium text-danger">{error}</p>
              </div>
            )}

            <button
              onClick={() => navigate('/')}
              className="mb-4 text-xs text-text-muted hover:text-text transition-colors"
            >
              ← All Templates
            </button>

            {/* Template metadata */}
            <div className="bg-surface rounded-lg border border-gray-200 p-6 mb-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1 uppercase tracking-wide">
                    Template Name
                  </label>
                  <input
                    type="text"
                    value={templateName}
                    onChange={e => setTemplateName(e.target.value)}
                    className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    placeholder="e.g. Clinical Tissue Specimen"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-text-muted mb-1 uppercase tracking-wide">
                    Description
                  </label>
                  <input
                    type="text"
                    value={templateDesc}
                    onChange={e => setTemplateDesc(e.target.value)}
                    className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    placeholder="Optional description"
                  />
                </div>
              </div>

              <div className="mt-3 flex items-center gap-3 text-xs text-text-muted">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                  parseResult.format === 'vendor'
                    ? 'bg-purple-100 text-purple-800'
                    : 'bg-blue-100 text-blue-800'
                }`}>
                  {formatBadge(parseResult.detectedFormat)}
                </span>
                {parseResult.rowCount > 0 && <span>{parseResult.rowCount.toLocaleString()} data rows</span>}
                <span>{parseResult.fields.length} fields</span>
                <span>sheets: {parseResult.sheets.join(', ')}</span>
              </div>

              {parseResult.identifierPattern && (
                <div className="mt-2 text-xs text-text-muted">
                  Identity pattern: <code className="bg-gray-100 px-1 py-0.5 rounded font-mono text-xs">{parseResult.identifierPattern}</code>
                  {parseResult.identityFields.length > 0 && (
                    <>
                      {' → '}
                      {parseResult.identityFields.map(f => (
                        <span key={f} className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-mono text-xs mr-1">{f}</span>
                      ))}
                    </>
                  )}
                </div>
              )}
              {parseResult.identityWarnings && parseResult.identityWarnings.length > 0 && (
                <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2">
                  {parseResult.identityWarnings.map((w, i) => (
                    <p key={i} className="text-xs text-amber-800">{w}</p>
                  ))}
                </div>
              )}
            </div>

            {/* Identity field info */}
            {parseResult.format === 'c02' && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4 text-sm text-amber-800">
                Select identity fields using the key icon to define how rows are deduplicated.
                {identityCount > 0 && <span className="font-medium ml-1">{identityCount} selected.</span>}
              </div>
            )}

            {/* Action bar */}
            <div className="bg-surface rounded-lg border border-gray-200 px-6 py-3 mb-4 flex items-center gap-4 sticky top-14 z-10">
              <span className="text-sm text-text-muted flex-1">
                <span className={allApproved ? 'text-success font-medium' : 'text-text'}>
                  {approvedCount} / {fields.length}
                </span>{' '}
                fields approved
              </span>
              <button
                onClick={unapproveAll}
                className="text-xs text-text-muted hover:text-text underline"
              >
                Clear all
              </button>
              <button
                onClick={approveAll}
                className="rounded-md bg-primary text-white text-sm px-4 py-2 hover:bg-primary-light transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40"
              >
                Approve All
              </button>
              <button
                onClick={handleSave}
                disabled={!allApproved || !templateName.trim() || phase === 'saving'}
                className="rounded-md bg-success text-white text-sm px-4 py-2 disabled:opacity-40 hover:bg-success/90 transition-colors focus:outline-none focus:ring-2 focus:ring-success/40"
              >
                {phase === 'saving' ? 'Saving…' : 'Save Template ▶'}
              </button>
            </div>

            {/* Field table */}
            <div className="bg-surface rounded-lg border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-xs text-text-muted uppercase tracking-wide">
                    <th className="px-3 py-2 text-left w-8">#</th>
                    <th className="px-3 py-2 text-left">Field Name</th>
                    <th className="px-3 py-2 text-left">Label</th>
                    <th className="px-3 py-2 text-left w-40">Type</th>
                    <th className="px-3 py-2 text-center w-16">Req</th>
                    <th className="px-3 py-2 text-center w-12" title="Identity field">
                      <svg className="inline w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                    </th>
                    <th className="px-3 py-2 text-left">LOV</th>
                    <th className="px-3 py-2 text-center w-16">✓</th>
                  </tr>
                </thead>
                <tbody>
                  {fields.map(field => {
                    const isApproved = field.approved
                    return (
                      <Fragment key={field.index}>
                        <tr
                          className={`
                            border-b border-gray-100 hover:bg-gray-50
                            border-l-4
                            ${isApproved ? 'border-l-success bg-green-50/30' : 'border-l-amber-300'}
                          `}
                        >
                          <td className="px-3 py-2 text-text-muted tabular-nums">{field.index + 1}</td>
                          <td className="px-3 py-2 font-mono text-xs text-text">{field.name}</td>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              value={field.label}
                              onChange={e => updateField(field.index, 'label', e.target.value)}
                              className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <select
                              value={field.type}
                              onChange={e => {
                                const newType = e.target.value as WipFieldType
                                setFields(prev => prev.map(f => {
                                  if (f.index !== field.index) return f
                                  return { ...f, type: newType, approved: false }
                                }))
                              }}
                              className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 bg-white"
                            >
                              {FIELD_TYPES.map(t => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={field.mandatory}
                              onChange={e => updateField(field.index, 'mandatory', e.target.checked)}
                              className="accent-primary w-4 h-4"
                            />
                          </td>
                          <td className="px-3 py-2 text-center">
                            <button
                              onClick={() => toggleIdentity(field.index)}
                              disabled={parseResult.format === 'vendor'}
                              className={`${
                                field.isIdentity
                                  ? 'text-amber-600'
                                  : parseResult.format === 'vendor'
                                    ? 'text-gray-200 cursor-not-allowed'
                                    : 'text-gray-300 hover:text-amber-400'
                              }`}
                              title={parseResult.format === 'vendor' ? 'Derived from Identifier Pattern' : 'Toggle identity field'}
                            >
                              <svg className="w-4 h-4" viewBox="0 0 24 24" fill={field.isIdentity ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                            </button>
                          </td>
                          <td className="px-3 py-2">
                            {field.type === 'term' ? (
                              <button
                                onClick={() => toggleExpand(field.index)}
                                className="text-xs text-primary underline hover:text-primary-light"
                              >
                                {lovLabel(field)}
                                {field.expanded ? ' ▲' : ' ▼'}
                              </button>
                            ) : (
                              <button
                                onClick={() => toggleExpand(field.index)}
                                className="text-xs text-text-muted hover:text-text"
                              >
                                —
                              </button>
                            )}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <button
                              onClick={() => toggleApprove(field.index)}
                              className={`
                                w-7 h-7 rounded-full border-2 text-sm font-bold transition-colors
                                ${isApproved
                                  ? 'bg-success border-success text-white'
                                  : 'border-gray-300 text-gray-300 hover:border-primary hover:text-primary'
                                }
                              `}
                            >
                              ✓
                            </button>
                          </td>
                        </tr>

                        {/* Expanded details row */}
                        {field.expanded && (
                          <tr
                            className={`border-b border-gray-100 border-l-4 ${isApproved ? 'border-l-success' : 'border-l-amber-300'}`}
                          >
                            <td colSpan={8} className={`px-4 py-3 ${field.type === 'term' ? 'bg-primary/5' : 'bg-gray-50/60'}`}>
                              <div className="flex gap-3 items-start">
                                {field.type === 'term' && (
                                  <div className="flex-1">
                                    <label className="block text-xs font-medium text-text-muted mb-1">
                                      LOV values — one per line
                                      {field.terminologyName && (
                                        <span className="ml-2 text-primary">from: {field.terminologyName}</span>
                                      )}
                                    </label>
                                    <textarea
                                      value={field.lovText}
                                      onChange={e => updateField(field.index, 'lovText', e.target.value)}
                                      rows={Math.min(12, field.lovText.split('\n').length + 2)}
                                      className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/40 resize-y"
                                      placeholder="One value per line…"
                                    />
                                    <p className="text-xs text-text-muted mt-1">
                                      {field.lovText.split('\n').filter(l => l.trim() !== '').length} values
                                    </p>
                                  </div>
                                )}
                                <div className={field.type === 'term' ? 'min-w-48 space-y-2' : 'flex-1 flex gap-3'}>
                                  <div className={field.type === 'term' ? '' : 'flex-1'}>
                                    <label className="block text-xs font-medium text-text-muted mb-1">Pattern (regex)</label>
                                    <input
                                      type="text"
                                      value={field.pattern}
                                      onChange={e => updateField(field.index, 'pattern', e.target.value)}
                                      className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
                                      placeholder="e.g. ^\d{4}-\d{2}$"
                                    />
                                  </div>
                                  {(field.type === 'number' || field.type === 'integer') && (
                                    <>
                                      <div>
                                        <label className="block text-xs font-medium text-text-muted mb-1">Min</label>
                                        <input
                                          type="number"
                                          value={field.minValue}
                                          onChange={e => updateField(field.index, 'minValue', e.target.value)}
                                          className="w-24 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                                        />
                                      </div>
                                      <div>
                                        <label className="block text-xs font-medium text-text-muted mb-1">Max</label>
                                        <input
                                          type="number"
                                          value={field.maxValue}
                                          onChange={e => updateField(field.index, 'maxValue', e.target.value)}
                                          className="w-24 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                                        />
                                      </div>
                                    </>
                                  )}
                                  {field.metadata && Object.keys(field.metadata).length > 0 && (
                                    <div className={field.type === 'term' ? 'mt-2' : 'flex-1'}>
                                      <label className="block text-xs font-medium text-text-muted mb-1">Metadata</label>
                                      <div className="text-xs text-text-muted space-y-0.5">
                                        {Object.entries(field.metadata).map(([k, v]) => (
                                          <div key={k}><span className="font-medium">{k}:</span> {String(v)}</div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-text-muted mt-2 text-center">
              Click the LOV badge (or "—") on any row to expand pattern, min/max, and metadata.
            </p>
          </>
        )}

        {/* ── Saved ─────────────────────────────────────────────────────────── */}
        {phase === 'saved' && saveResult && (
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
            <div className="text-5xl">✅</div>
            <div className="bg-surface rounded-lg border border-gray-200 p-8 max-w-lg w-full text-center space-y-3 shadow-sm">
              <h2 className="text-xl font-semibold text-text">{templateName}</h2>
              <p className="text-text-muted text-sm">Template saved to WIP</p>
              <div className="bg-background rounded-lg p-4 text-left space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-text-muted">Document ID</span>
                  <span className="font-mono text-xs text-text">{saveResult.templateDocumentId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">WIP Template</span>
                  <span className="font-mono text-xs text-text">{saveResult.wipTemplateValue}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-text-muted">Fields</span>
                  <span className="text-text">{saveResult.fieldCount}</span>
                </div>
                {saveResult.terminologiesCreated.length > 0 && (
                  <div>
                    <span className="text-text-muted block mb-1">LOV terminologies created</span>
                    <ul className="space-y-1">
                      {saveResult.terminologiesCreated.map(t => (
                        <li key={t} className="font-mono text-xs text-text bg-surface rounded border border-gray-200 px-2 py-1">{t}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => navigate(`/templates/${saveResult.templateDocumentId}`)}
                  className="rounded-md bg-primary text-white px-6 py-2 text-sm font-medium hover:bg-primary-light transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  View Template →
                </button>
                <button
                  onClick={reset}
                  className="rounded-md border border-primary px-6 py-2 text-sm font-medium text-primary hover:bg-primary/5 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  Parse another file
                </button>
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
