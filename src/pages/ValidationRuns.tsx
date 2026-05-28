import { useCallback, useEffect, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ValRun {
  document_id: string
  version: number
  created_at: string
  run_status: string
  row_count: number | null
  error_count: number | null
  warning_count: number | null
  run_at: string | null
  run_by: string | null
  source_file: string | null
  source_filename: string | null
  template: string | null
  template_name: string | null
}

interface ListResponse {
  items: ValRun[]
  total: number
  pages: number
}

interface RevalidateError {
  row: number
  column: string
  value: string
  message: string
}

interface RevalidateResult {
  runId: string
  filename: string
  status: string
  rowCount: number
  errorCount: number
  errors: RevalidateError[]
}

interface TemplateOption {
  document_id: string
  data: { name: string }
}

type Phase = 'idle' | 'loading' | 'revalidating'

const PAGE_SIZE = 20

// ─── Component ────────────────────────────────────────────────────────────────

export default function ValidationRuns() {
  const [items, setItems] = useState<ValRun[]>([])
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [page, setPage] = useState(1)
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState<string | null>(null)

  const [templateFilter, setTemplateFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [templates, setTemplates] = useState<TemplateOption[]>([])

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [revalidateResults, setRevalidateResults] = useState<Map<string, RevalidateResult> | null>(null)
  const [expandedRun, setExpandedRun] = useState<string | null>(null)

  // Load templates for filter dropdown
  useEffect(() => {
    fetch('/api/val-templates?pageSize=100')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((data: { items: TemplateOption[] }) => setTemplates(data.items))
      .catch(() => {})
  }, [])

  const fetchRuns = useCallback((p: number, tpl: string, status: string) => {
    setPhase('loading')
    setError(null)
    const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
    if (tpl) params.set('template', tpl)
    if (status) params.set('status', status)
    fetch(`/api/val-runs?${params}`)
      .then(r => r.ok ? r.json() : r.json().then((b: { error: string }) => Promise.reject(b.error)))
      .then((data: ListResponse) => {
        setItems(data.items)
        setTotal(data.total)
        setPages(data.pages)
        setPhase('idle')
      })
      .catch((e: unknown) => {
        setError(typeof e === 'string' ? e : 'Failed to load runs')
        setPhase('idle')
      })
  }, [])

  useEffect(() => {
    fetchRuns(page, templateFilter, statusFilter)
  }, [page, templateFilter, statusFilter, fetchRuns])

  function handleTemplateFilter(value: string) {
    setTemplateFilter(value)
    setPage(1)
    setSelected(new Set())
  }

  function handleStatusFilter(value: string) {
    setStatusFilter(value)
    setPage(1)
    setSelected(new Set())
  }

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selected.size === items.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(items.map(r => r.document_id)))
    }
  }

  async function handleRevalidate() {
    if (selected.size === 0) return
    setPhase('revalidating')
    setRevalidateResults(null)
    try {
      const res = await fetch('/api/val-runs/revalidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runIds: [...selected] }),
      })
      const data = await res.json() as { results: RevalidateResult[] } | { error: string }
      if (!res.ok) {
        setError('error' in data ? data.error : 'Re-validation failed')
        setPhase('idle')
        return
      }
      const resultsMap = new Map<string, RevalidateResult>()
      for (const r of (data as { results: RevalidateResult[] }).results) {
        resultsMap.set(r.runId, r)
      }
      setRevalidateResults(resultsMap)
      fetchRuns(page, templateFilter, statusFilter)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Network error')
      setPhase('idle')
    }
  }

  async function handleArchive(ids: string[]) {
    try {
      await Promise.all(ids.map(id =>
        fetch(`/api/val-runs/${id}`, { method: 'DELETE' })
      ))
      setSelected(new Set())
      fetchRuns(page, templateFilter, statusFilter)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Archive failed')
    }
  }

  function statusBadge(run: ValRun) {
    if (run.run_status === 'complete' && (run.error_count ?? 0) === 0) {
      return <span className="inline-flex items-center rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">Passed</span>
    }
    if (run.run_status === 'complete' && (run.error_count ?? 0) > 0) {
      return <span className="inline-flex items-center rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">Failed ({run.error_count})</span>
    }
    if (run.run_status === 'pending') {
      return <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-text-muted">Pending</span>
    }
    if (run.run_status === 'running') {
      return <span className="inline-flex items-center rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">Running</span>
    }
    if (run.run_status === 'failed') {
      return <span className="inline-flex items-center rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">Error</span>
    }
    return <span className="text-xs text-text-muted">{run.run_status}</span>
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">

        {/* Page header */}
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-text">Validation Runs</h1>
          <p className="mt-1 text-sm text-text-muted">
            {phase === 'loading' ? 'Loading…' : `${total} run${total !== 1 ? 's' : ''}`}
          </p>
        </header>

        {/* Filters */}
        <div className="mb-4 flex items-center gap-3 flex-wrap">
          <select
            value={templateFilter}
            onChange={e => handleTemplateFilter(e.target.value)}
            className="rounded-md border border-gray-200 bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="">All templates</option>
            {templates.map(t => (
              <option key={t.document_id} value={t.document_id}>{t.data.name}</option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={e => handleStatusFilter(e.target.value)}
            className="rounded-md border border-gray-200 bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="">All statuses</option>
            <option value="complete">Complete</option>
            <option value="pending">Pending</option>
            <option value="failed">Error</option>
          </select>
          {(templateFilter || statusFilter) && (
            <button
              onClick={() => { handleTemplateFilter(''); handleStatusFilter('') }}
              className="text-xs text-text-muted hover:text-text"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Bulk actions */}
        {selected.size > 0 && (
          <div className="mb-4 flex items-center gap-3 rounded-md border border-primary/20 bg-primary/5 px-4 py-2.5">
            <span className="text-sm font-medium text-text">{selected.size} selected</span>
            <button
              onClick={handleRevalidate}
              disabled={phase === 'revalidating'}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-light disabled:opacity-40"
            >
              {phase === 'revalidating' ? 'Re-validating…' : 'Re-validate'}
            </button>
            <button
              onClick={() => handleArchive([...selected])}
              className="rounded-md border border-danger/30 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/5"
            >
              Archive
            </button>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-lg border border-danger/20 bg-danger/5 p-4">
            <p className="text-sm font-medium text-danger">{error}</p>
          </div>
        )}

        {/* Empty state */}
        {phase === 'idle' && !error && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-base font-medium text-text">No validation runs yet</p>
            <p className="mt-1 text-sm text-text-muted">
              Validate some documents — runs will appear here automatically.
            </p>
          </div>
        )}

        {/* Runs table */}
        {items.length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-surface overflow-hidden">
            <table className="min-w-full text-sm">
              <thead className="bg-background border-b border-gray-200">
                <tr>
                  <th className="px-3 py-2.5 text-left w-10">
                    <input
                      type="checkbox"
                      checked={selected.size === items.length && items.length > 0}
                      onChange={toggleSelectAll}
                      className="rounded border-gray-300"
                    />
                  </th>
                  <th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Filename</th>
                  <th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Template</th>
                  <th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Status</th>
                  <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Rows</th>
                  <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Errors</th>
                  <th className="px-3 py-2.5 text-left text-xs font-medium text-text-muted">Date</th>
                  <th className="px-3 py-2.5 text-right text-xs font-medium text-text-muted">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map(run => {
                  const isExpanded = expandedRun === run.document_id
                  const revalResult = revalidateResults?.get(run.document_id)
                  return (
                    <>
                      <tr key={run.document_id} className="group">
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={selected.has(run.document_id)}
                            onChange={() => toggleSelect(run.document_id)}
                            className="rounded border-gray-300"
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          <button
                            onClick={() => setExpandedRun(isExpanded ? null : run.document_id)}
                            className="text-sm font-medium text-text hover:text-primary truncate max-w-[200px] block text-left"
                            title={run.source_filename || ''}
                          >
                            {run.source_filename || '(no filename)'}
                          </button>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-text-muted truncate max-w-[150px]">
                          {run.template_name || '—'}
                        </td>
                        <td className="px-3 py-2.5">{statusBadge(run)}</td>
                        <td className="px-3 py-2.5 text-right text-text-muted tabular-nums">{run.row_count ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {run.error_count != null && run.error_count > 0
                            ? <span className="text-danger font-medium">{run.error_count}</span>
                            : <span className="text-text-muted">{run.error_count ?? '—'}</span>
                          }
                        </td>
                        <td className="px-3 py-2.5 text-xs text-text-muted">
                          {run.run_at ? new Date(run.run_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <a
                              href={`/api/val-runs/${run.document_id}/download`}
                              className="text-xs text-primary hover:underline"
                              download
                            >
                              Download
                            </a>
                            <button
                              onClick={() => handleArchive([run.document_id])}
                              className="text-xs text-danger hover:underline"
                            >
                              Archive
                            </button>
                          </div>
                        </td>
                      </tr>
                      {isExpanded && revalResult && (
                        <tr key={`${run.document_id}-detail`}>
                          <td colSpan={8} className="px-4 py-3 bg-background">
                            {revalResult.errorCount === 0 ? (
                              <p className="text-sm text-success font-medium">No errors on last re-validation</p>
                            ) : (
                              <div className="space-y-2">
                                <p className="text-sm font-medium text-danger">
                                  {revalResult.errorCount} error{revalResult.errorCount !== 1 ? 's' : ''} ({revalResult.rowCount} rows)
                                </p>
                                <div className="overflow-x-auto rounded-md border border-gray-200 max-h-64 overflow-y-auto">
                                  <table className="min-w-full text-xs">
                                    <thead className="bg-surface sticky top-0">
                                      <tr>
                                        <th className="px-2 py-1.5 text-left font-medium text-text-muted w-14">Row</th>
                                        <th className="px-2 py-1.5 text-left font-medium text-text-muted">Column</th>
                                        <th className="px-2 py-1.5 text-left font-medium text-text-muted">Value</th>
                                        <th className="px-2 py-1.5 text-left font-medium text-text-muted">Issue</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50">
                                      {revalResult.errors.slice(0, 50).map((err, i) => (
                                        <tr key={i}>
                                          <td className="px-2 py-1.5 text-text-muted tabular-nums">{err.row}</td>
                                          <td className="px-2 py-1.5 font-mono text-text">{err.column}</td>
                                          <td className="px-2 py-1.5 font-mono text-text truncate max-w-[150px]" title={err.value}>{err.value || '(empty)'}</td>
                                          <td className="px-2 py-1.5 text-text">{err.message}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                                {revalResult.errors.length > 50 && (
                                  <p className="text-xs text-text-muted">Showing first 50 of {revalResult.errors.length} errors</p>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {pages > 1 && (
          <div className="mt-6 flex items-center justify-center gap-4">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-md border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ← Prev
            </button>
            <span className="text-sm text-text-muted">Page {page} of {pages}</span>
            <button
              onClick={() => setPage(p => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="rounded-md border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          </div>
        )}

      </main>
    </div>
  )
}
