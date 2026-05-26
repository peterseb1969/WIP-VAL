import { Fragment, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

// ─── Types (mirrored from server) ─────────────────────────────────────────────

type ColumnType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'email' | 'url' | 'term'

interface ColumnGuess {
  columnIndex: number
  columnName: string
  guessedType: ColumnType
  required: boolean
  uniqueValueCount: number
  sampleValues: string[]
  lovValues?: string[]
  lovFromSheet?: string
}

interface ParseResult {
  suggestedName: string
  rowCount: number
  sheets: string[]
  columns: ColumnGuess[]
  wipFileId?: string
  wipFileWarning?: string
}

// Working copy — what the user edits and approves
interface ColumnDef {
  columnIndex: number
  columnName: string       // read-only
  displayName: string
  type: ColumnType
  required: boolean
  pattern: string
  minValue: string
  maxValue: string
  lovText: string          // newline-separated for editing
  description: string
  approved: boolean
  lovExpanded: boolean
}

interface SaveResult {
  templateDocumentId: string
  columnCount: number
  terminologiesCreated: string[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const COLUMN_TYPES: { value: ColumnType; label: string }[] = [
  { value: 'string',   label: 'String' },
  { value: 'number',   label: 'Number' },
  { value: 'integer',  label: 'Integer' },
  { value: 'boolean',  label: 'Boolean' },
  { value: 'date',     label: 'Date' },
  { value: 'datetime', label: 'Date+Time' },
  { value: 'email',    label: 'Email' },
  { value: 'url',      label: 'URL' },
  { value: 'term',     label: 'Controlled (LOV)' },
]

function guessToColumnDef(g: ColumnGuess): ColumnDef {
  return {
    columnIndex: g.columnIndex,
    columnName: g.columnName,
    displayName: g.columnName,
    type: g.guessedType,
    required: g.required,
    pattern: '',
    minValue: '',
    maxValue: '',
    lovText: g.lovValues ? g.lovValues.join('\n') : '',
    description: '',
    approved: false,
    lovExpanded: false,
  }
}

function lovLabel(col: ColumnDef, guess: ColumnGuess): string {
  const count = col.lovText.split('\n').filter(l => l.trim() !== '').length
  if (count === 0) return guess.lovFromSheet ? `sheet: ${guess.lovFromSheet}` : 'no values'
  return `${count} value${count !== 1 ? 's' : ''}${guess.lovFromSheet ? ` (${guess.lovFromSheet})` : ''}`
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

  // Reviewing state
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)
  const [columns, setColumns] = useState<ColumnDef[]>([])
  const [templateName, setTemplateName] = useState('')
  const [templateDesc, setTemplateDesc] = useState('')

  // Saved state
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
      const result: ParseResult = await res.json()
      setParseResult(result)
      setTemplateName(result.suggestedName)
      setColumns(result.columns.map(guessToColumnDef))
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

  // ── Column editing ──────────────────────────────────────────────────────────

  function updateCol<K extends keyof ColumnDef>(idx: number, key: K, value: ColumnDef[K]) {
    setColumns(prev => prev.map(c =>
      c.columnIndex === idx ? { ...c, [key]: value, approved: false } : c
    ))
  }

  function toggleApprove(idx: number) {
    setColumns(prev => prev.map(c =>
      c.columnIndex === idx ? { ...c, approved: !c.approved } : c
    ))
  }

  function toggleLov(idx: number) {
    setColumns(prev => prev.map(c =>
      c.columnIndex === idx ? { ...c, lovExpanded: !c.lovExpanded } : c
    ))
  }

  function approveAll() {
    setColumns(prev => prev.map(c => ({ ...c, approved: true })))
  }

  function unapproveAll() {
    setColumns(prev => prev.map(c => ({ ...c, approved: false })))
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!allApproved) return
    setError(null)
    setPhase('saving')

    const payload = {
      templateName,
      templateDescription: templateDesc,
      wipFileId: parseResult?.wipFileId,
      columns: columns.map(c => ({
        columnIndex: c.columnIndex,
        columnName: c.columnName,
        displayName: c.displayName || c.columnName,
        columnType: c.type,
        required: c.required,
        pattern: c.pattern || undefined,
        minValue: c.minValue !== '' ? Number(c.minValue) : undefined,
        maxValue: c.maxValue !== '' ? Number(c.maxValue) : undefined,
        lovValues: c.type === 'term'
          ? c.lovText.split('\n').map(l => l.trim()).filter(l => l !== '')
          : undefined,
        description: c.description || undefined,
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
    setColumns([])
    setTemplateName('')
    setTemplateDesc('')
    setSaveResult(null)
    setError(null)
  }

  // ── Derived ─────────────────────────────────────────────────────────────────

  const approvedCount = columns.filter(c => c.approved).length
  const allApproved = columns.length > 0 && approvedCount === columns.length

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

            {/* Back link */}
            <button
              onClick={() => navigate('/')}
              className="mb-4 text-xs text-text-muted hover:text-text transition-colors"
            >
              ← All Templates
            </button>

            {/* Template metadata */}
            <div className="bg-surface rounded-lg border border-gray-200 p-6 mb-4 grid grid-cols-1 md:grid-cols-2 gap-4">
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
              <div className="text-xs text-text-muted md:col-span-2">
                {parseResult.rowCount.toLocaleString()} data rows · {parseResult.columns.length} columns · sheets: {parseResult.sheets.join(', ')}
              </div>
            </div>

            {/* Action bar */}
            <div className="bg-surface rounded-lg border border-gray-200 px-6 py-3 mb-4 flex items-center gap-4 sticky top-14 z-10">
              <span className="text-sm text-text-muted flex-1">
                <span className={allApproved ? 'text-success font-medium' : 'text-text'}>
                  {approvedCount} / {columns.length}
                </span>{' '}
                columns approved
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

            {/* Column table */}
            <div className="bg-surface rounded-lg border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-xs text-text-muted uppercase tracking-wide">
                    <th className="px-3 py-2 text-left w-8">#</th>
                    <th className="px-3 py-2 text-left">Column Name</th>
                    <th className="px-3 py-2 text-left">Display Name</th>
                    <th className="px-3 py-2 text-left w-40">Type</th>
                    <th className="px-3 py-2 text-center w-16">Req</th>
                    <th className="px-3 py-2 text-left">LOV</th>
                    <th className="px-3 py-2 text-center w-16">✓</th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map(col => {
                    // columnIndex is always a valid index — columns and parseResult.columns built in tandem
                    const guess = parseResult.columns[col.columnIndex]!
                    const isApproved = col.approved
                    return (
                      <Fragment key={col.columnIndex}>
                        <tr
                          className={`
                            border-b border-gray-100 hover:bg-gray-50
                            border-l-4
                            ${isApproved ? 'border-l-success bg-green-50/30' : 'border-l-amber-300'}
                          `}
                        >
                          <td className="px-3 py-2 text-text-muted tabular-nums">{col.columnIndex + 1}</td>
                          <td className="px-3 py-2 font-mono text-xs text-text">{col.columnName}</td>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              value={col.displayName}
                              onChange={e => updateCol(col.columnIndex, 'displayName', e.target.value)}
                              className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <select
                              value={col.type}
                              onChange={e => {
                                const newType = e.target.value as ColumnType
                                setColumns(prev => prev.map(c => {
                                  if (c.columnIndex !== col.columnIndex) return c
                                  const lovText = newType === 'term'
                                    ? (guess.lovValues ? guess.lovValues.join('\n') : c.lovText)
                                    : c.lovText
                                  return { ...c, type: newType, lovText, approved: false }
                                }))
                              }}
                              className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 bg-white"
                            >
                              {COLUMN_TYPES.map(t => (
                                <option key={t.value} value={t.value}>{t.label}</option>
                              ))}
                            </select>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={col.required}
                              onChange={e => updateCol(col.columnIndex, 'required', e.target.checked)}
                              className="accent-primary w-4 h-4"
                            />
                          </td>
                          <td className="px-3 py-2">
                            {col.type === 'term' ? (
                              <button
                                onClick={() => toggleLov(col.columnIndex)}
                                className="text-xs text-primary underline hover:text-primary-light"
                              >
                                {lovLabel(col, guess)}
                                {col.lovExpanded ? ' ▲' : ' ▼'}
                              </button>
                            ) : (
                              <button
                                onClick={() => toggleLov(col.columnIndex)}
                                className="text-xs text-text-muted hover:text-text"
                                aria-label="Expand column options"
                              >
                                —
                              </button>
                            )}
                          </td>
                          <td className="px-3 py-2 text-center">
                            <button
                              onClick={() => toggleApprove(col.columnIndex)}
                              aria-label={isApproved ? 'Unapprove column' : 'Approve column'}
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

                        {/* LOV editor row */}
                        {col.type === 'term' && col.lovExpanded && (
                          <tr
                            className={`border-b border-gray-100 border-l-4 ${isApproved ? 'border-l-success' : 'border-l-amber-300'}`}
                          >
                            <td colSpan={7} className="px-4 py-3 bg-primary/5">
                              <div className="flex gap-3 items-start">
                                <div className="flex-1">
                                  <label className="block text-xs font-medium text-text-muted mb-1">
                                    LOV values — one per line
                                    {guess.lovFromSheet && (
                                      <span className="ml-2 text-primary">from sheet: {guess.lovFromSheet}</span>
                                    )}
                                  </label>
                                  <textarea
                                    value={col.lovText}
                                    onChange={e => updateCol(col.columnIndex, 'lovText', e.target.value)}
                                    rows={Math.min(12, col.lovText.split('\n').length + 2)}
                                    className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/40 resize-y"
                                    placeholder="One value per line…"
                                  />
                                  <p className="text-xs text-text-muted mt-1">
                                    {col.lovText.split('\n').filter(l => l.trim() !== '').length} values
                                  </p>
                                </div>
                                <div className="min-w-48 space-y-2">
                                  <div>
                                    <label className="block text-xs font-medium text-text-muted mb-1">Description</label>
                                    <input
                                      type="text"
                                      value={col.description}
                                      onChange={e => updateCol(col.columnIndex, 'description', e.target.value)}
                                      className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                                      placeholder="Optional"
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-xs font-medium text-text-muted mb-1">Pattern (regex)</label>
                                    <input
                                      type="text"
                                      value={col.pattern}
                                      onChange={e => updateCol(col.columnIndex, 'pattern', e.target.value)}
                                      className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
                                      placeholder="e.g. ^\d{4}-\d{2}$"
                                    />
                                  </div>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}

                        {/* Non-LOV extra fields */}
                        {col.type !== 'term' && col.lovExpanded && (
                          <tr
                            className={`border-b border-gray-100 border-l-4 ${isApproved ? 'border-l-success' : 'border-l-amber-300'}`}
                          >
                            <td colSpan={7} className="px-4 py-3 bg-gray-50/60">
                              <div className="flex gap-3">
                                <div className="flex-1">
                                  <label className="block text-xs font-medium text-text-muted mb-1">Description</label>
                                  <input
                                    type="text"
                                    value={col.description}
                                    onChange={e => updateCol(col.columnIndex, 'description', e.target.value)}
                                    className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                                    placeholder="Optional"
                                  />
                                </div>
                                <div>
                                  <label className="block text-xs font-medium text-text-muted mb-1">Pattern (regex)</label>
                                  <input
                                    type="text"
                                    value={col.pattern}
                                    onChange={e => updateCol(col.columnIndex, 'pattern', e.target.value)}
                                    className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
                                    placeholder="e.g. ^\d{4}$"
                                  />
                                </div>
                                {(col.type === 'number' || col.type === 'integer') && (
                                  <>
                                    <div>
                                      <label className="block text-xs font-medium text-text-muted mb-1">Min</label>
                                      <input
                                        type="number"
                                        value={col.minValue}
                                        onChange={e => updateCol(col.columnIndex, 'minValue', e.target.value)}
                                        className="w-24 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-xs font-medium text-text-muted mb-1">Max</label>
                                      <input
                                        type="number"
                                        value={col.maxValue}
                                        onChange={e => updateCol(col.columnIndex, 'maxValue', e.target.value)}
                                        className="w-24 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                                      />
                                    </div>
                                  </>
                                )}
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

            {/* Extra fields toggle hint */}
            <p className="text-xs text-text-muted mt-2 text-center">
              Click the LOV badge (or "—") on any row to expand description, pattern, and min/max fields.
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
                  <span className="text-text-muted">Columns</span>
                  <span className="text-text">{saveResult.columnCount}</span>
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
