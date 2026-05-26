import { useCallback, useEffect, useRef, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TemplateOption {
  document_id: string
  data: { name: string; description?: string }
}

interface ValidationError {
  row: number
  column: string
  value: string
  message: string
}

interface FileResult {
  filename: string
  rowCount: number
  errorCount: number
  missingColumns: string[]
  errors: ValidationError[]
}

interface ValidationResponse {
  templateName: string
  totalErrors: number
  results: FileResult[]
}

type Phase = 'idle' | 'validating' | 'results'

const ACCEPT = '.xlsx,.xls,.csv'

// ─── Component ────────────────────────────────────────────────────────────────

export default function ValidateDocuments() {
  const [templates, setTemplates] = useState<TemplateOption[]>([])
  const [templatesError, setTemplatesError] = useState<string | null>(null)

  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [isDragOver, setIsDragOver] = useState(false)

  const [phase, setPhase] = useState<Phase>('idle')
  const [results, setResults] = useState<ValidationResponse | null>(null)
  const [validateError, setValidateError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/val-templates?pageSize=100')
      .then(r => r.ok ? r.json() : r.json().then((b: { error: string }) => Promise.reject(b.error)))
      .then((data: { items: TemplateOption[] }) => setTemplates(data.items))
      .catch((e: unknown) => setTemplatesError(typeof e === 'string' ? e : 'Failed to load templates'))
  }, [])

  function addFiles(incoming: FileList | File[]) {
    const arr = Array.from(incoming)
    setFiles(prev => {
      const existing = new Set(prev.map(f => f.name))
      return [...prev, ...arr.filter(f => !existing.has(f.name))]
    })
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleValidate() {
    if (!selectedTemplateId || files.length === 0) return
    setPhase('validating')
    setValidateError(null)
    setResults(null)

    const form = new FormData()
    form.append('templateId', selectedTemplateId)
    for (const f of files) form.append('files', f)

    try {
      const res = await fetch('/api/validate', { method: 'POST', body: form })
      const data = await res.json() as ValidationResponse | { error: string }
      if (!res.ok) {
        setValidateError('error' in data ? data.error : 'Validation failed')
        setPhase('idle')
        return
      }
      const vr = data as ValidationResponse
      setExpanded(new Set(vr.results.filter(r => r.errorCount > 0 || r.missingColumns.length > 0).map(r => r.filename)))
      setResults(vr)
      setPhase('results')
    } catch (e: unknown) {
      setValidateError(e instanceof Error ? e.message : 'Network error')
      setPhase('idle')
    }
  }

  function toggleExpanded(filename: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }

  function reset() {
    setFiles([])
    setResults(null)
    setValidateError(null)
    setPhase('idle')
    setExpanded(new Set())
  }

  const canValidate = selectedTemplateId !== '' && files.length > 0

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">

        {/* Page header */}
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-text">Validate Documents</h1>
          <p className="mt-1 text-sm text-text-muted">
            Upload spreadsheets and validate them against a validation template.
          </p>
        </header>

        {/* Templates load error */}
        {templatesError && (
          <div className="mb-4 rounded-lg border border-danger/20 bg-danger/5 p-4">
            <p className="text-sm font-medium text-danger">{templatesError}</p>
          </div>
        )}

        {/* Config card */}
        <div className="rounded-lg border border-gray-200 bg-surface p-6 space-y-5 mb-6">

          {/* Template selector */}
          <div>
            <label className="block text-sm font-medium text-text mb-1.5">
              Validation Template
            </label>
            <select
              value={selectedTemplateId}
              onChange={e => setSelectedTemplateId(e.target.value)}
              className="w-full max-w-sm rounded-md border border-gray-200 bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">Select a template…</option>
              {templates.map(t => (
                <option key={t.document_id} value={t.document_id}>
                  {t.data.name}
                </option>
              ))}
            </select>
          </div>

          {/* Drop zone */}
          <div>
            <label className="block text-sm font-medium text-text mb-1.5">
              Spreadsheet Files
            </label>
            <div
              onDragOver={e => { e.preventDefault(); setIsDragOver(true) }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`cursor-pointer rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors ${
                isDragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-gray-200 hover:border-primary/40 hover:bg-background'
              }`}
            >
              <p className="text-sm font-medium text-text">
                Drop files here or <span className="text-primary">browse</span>
              </p>
              <p className="mt-1 text-xs text-text-muted">.xlsx, .xls, .csv — multiple files allowed</p>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT}
                multiple
                className="sr-only"
                onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
              />
            </div>

            {/* File chips */}
            {files.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {files.map(f => (
                  <li key={f.name} className="flex items-center justify-between rounded-md border border-gray-200 bg-background px-3 py-2">
                    <span className="text-sm text-text truncate min-w-0">{f.name}</span>
                    <button
                      onClick={e => { e.stopPropagation(); setFiles(prev => prev.filter(x => x.name !== f.name)) }}
                      className="ml-3 shrink-0 text-text-muted hover:text-danger leading-none text-lg"
                      aria-label={`Remove ${f.name}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {files.length > 1 && (
              <button
                onClick={() => setFiles([])}
                className="mt-2 text-xs text-text-muted hover:text-danger"
              >
                Clear all
              </button>
            )}
          </div>
        </div>

        {/* Validate error */}
        {validateError && (
          <div className="mb-4 rounded-lg border border-danger/20 bg-danger/5 p-4">
            <p className="text-sm font-medium text-danger">{validateError}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-3 mb-8">
          <button
            onClick={handleValidate}
            disabled={!canValidate || phase === 'validating'}
            className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {phase === 'validating' ? 'Validating…' : 'Validate'}
          </button>
          {phase === 'results' && (
            <button
              onClick={reset}
              className="rounded-md border border-gray-200 px-4 py-2 text-sm font-medium text-text hover:bg-background focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              Clear results
            </button>
          )}
        </div>

        {/* Results */}
        {phase === 'results' && results && (
          <div className="space-y-4">

            {/* Summary banner */}
            {results.totalErrors === 0 ? (
              <div className="rounded-lg border border-success/30 bg-success/5 p-4 flex items-center gap-3">
                <span className="text-success font-semibold">✓</span>
                <div>
                  <p className="text-sm font-medium text-success">All files passed validation</p>
                  <p className="text-xs text-text-muted mt-0.5">
                    {results.results.length} file{results.results.length !== 1 ? 's' : ''} validated against &ldquo;{results.templateName}&rdquo;
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-danger/20 bg-danger/5 p-4 flex items-center gap-3">
                <span className="text-danger text-lg font-semibold">{results.totalErrors}</span>
                <div>
                  <p className="text-sm font-medium text-danger">
                    {results.totalErrors} error{results.totalErrors !== 1 ? 's' : ''} found
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    In {results.results.filter(r => r.errorCount > 0).length} of {results.results.length} file{results.results.length !== 1 ? 's' : ''}, validated against &ldquo;{results.templateName}&rdquo;
                  </p>
                </div>
              </div>
            )}

            {/* Per-file cards */}
            {results.results.map(fileResult => {
              const isExpanded = expanded.has(fileResult.filename)
              const hasIssues = fileResult.errorCount > 0 || fileResult.missingColumns.length > 0

              return (
                <div key={fileResult.filename} className="rounded-lg border border-gray-200 bg-surface overflow-hidden">

                  {/* File header (toggle) */}
                  <button
                    onClick={() => toggleExpanded(fileResult.filename)}
                    className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-background transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-sm font-medium text-text truncate">{fileResult.filename}</span>
                      <span className="text-xs text-text-muted shrink-0">
                        {fileResult.rowCount} row{fileResult.rowCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      {hasIssues ? (
                        <span className="inline-flex items-center rounded-full bg-danger/10 px-2.5 py-0.5 text-xs font-medium text-danger">
                          {fileResult.errorCount} error{fileResult.errorCount !== 1 ? 's' : ''}
                          {fileResult.missingColumns.length > 0 ? ` + ${fileResult.missingColumns.length} missing col${fileResult.missingColumns.length !== 1 ? 's' : ''}` : ''}
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success">
                          Pass
                        </span>
                      )}
                      <span className="text-text-muted text-xs">{isExpanded ? '▲' : '▼'}</span>
                    </div>
                  </button>

                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="border-t border-gray-200 px-4 py-4 space-y-4">

                      {/* Missing columns warning */}
                      {fileResult.missingColumns.length > 0 && (
                        <div className="rounded-md border border-accent/30 bg-accent/5 p-3">
                          <p className="text-sm font-medium text-accent mb-1">
                            {fileResult.missingColumns.length} column{fileResult.missingColumns.length !== 1 ? 's' : ''} missing from spreadsheet
                          </p>
                          <p className="text-xs text-text-muted font-mono">
                            {fileResult.missingColumns.join(', ')}
                          </p>
                        </div>
                      )}

                      {/* All clear */}
                      {fileResult.errorCount === 0 && fileResult.missingColumns.length === 0 && (
                        <p className="text-sm font-medium text-success">No validation errors found.</p>
                      )}

                      {/* Error table */}
                      {fileResult.errors.length > 0 && (
                        <div>
                          <div className="overflow-x-auto rounded-md border border-gray-200">
                            <table className="min-w-full text-sm">
                              <thead className="bg-background">
                                <tr>
                                  <th className="px-3 py-2 text-left text-xs font-medium text-text-muted w-16">Row</th>
                                  <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Column</th>
                                  <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Value</th>
                                  <th className="px-3 py-2 text-left text-xs font-medium text-text-muted">Issue</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-100">
                                {fileResult.errors.map((err, i) => (
                                  <tr key={i} className="hover:bg-background">
                                    <td className="px-3 py-2 text-text-muted tabular-nums">{err.row}</td>
                                    <td className="px-3 py-2 font-mono text-xs text-text">{err.column}</td>
                                    <td className="px-3 py-2 font-mono text-xs text-text max-w-xs truncate" title={err.value}>
                                      {err.value || <em className="text-text-muted not-italic">(empty)</em>}
                                    </td>
                                    <td className="px-3 py-2 text-text">{err.message}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {fileResult.errorCount >= 100 && (
                            <p className="mt-2 text-xs text-text-muted">
                              Showing first 100 errors — fix these and re-validate to see more.
                            </p>
                          )}
                        </div>
                      )}

                    </div>
                  )}
                </div>
              )
            })}

          </div>
        )}

      </main>
    </div>
  )
}
