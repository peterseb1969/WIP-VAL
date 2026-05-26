import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

// ─── Types ────────────────────────────────────────────────────────────────────

interface TemplateData {
  name: string
  description?: string
  column_count?: number
  created_by?: string
}

interface TemplateDoc {
  document_id: string
  data: TemplateData
  created_at: string
  version: number
}

interface ListResponse {
  items: TemplateDoc[]
  total: number
  pages: number
}

// ─── Component ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20

export default function TemplateList() {
  const navigate = useNavigate()
  const [items, setItems] = useState<TemplateDoc[]>([])
  const [total, setTotal] = useState(0)
  const [pages, setPages] = useState(1)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function fetchTemplates(q: string, p: number) {
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) })
    if (q) params.set('search', q)
    fetch(`/api/val-templates?${params}`)
      .then(r => r.ok ? r.json() : r.json().then((b: { error: string }) => Promise.reject(b.error)))
      .then((data: ListResponse) => {
        setItems(data.items)
        setTotal(data.total)
        setPages(data.pages)
        setLoading(false)
      })
      .catch((e: unknown) => {
        setError(typeof e === 'string' ? e : 'Failed to load templates')
        setLoading(false)
      })
  }

  // Initial load
  useEffect(() => {
    fetchTemplates(search, page)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced search
  function handleSearch(value: string) {
    setSearch(value)
    setPage(1)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => fetchTemplates(value, 1), 300)
  }

  function handlePageChange(next: number) {
    setPage(next)
    fetchTemplates(search, next)
  }

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">

        {/* Page header */}
        <header className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-text">Validation Templates</h1>
            <p className="mt-1 text-sm text-text-muted">
              {loading ? 'Loading…' : `${total.toLocaleString()} template${total !== 1 ? 's' : ''}`}
            </p>
          </div>
          <button
            onClick={() => navigate('/parse-template')}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            + New Template
          </button>
        </header>

        {/* Search */}
        <div className="mb-4">
          <input
            type="search"
            value={search}
            onChange={e => handleSearch(e.target.value)}
            placeholder="Search by name…"
            className="w-full max-w-sm rounded-md border border-gray-200 bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        {/* Error */}
        {error && (
          <div className="mb-4 rounded-lg border border-danger/20 bg-danger/5 p-4">
            <p className="text-sm font-medium text-danger">{error}</p>
          </div>
        )}

        {/* List */}
        {!loading && !error && items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-base font-medium text-text">
              {search ? 'No templates match your search' : 'No templates yet'}
            </p>
            <p className="mt-1 text-sm text-text-muted">
              {search ? 'Try a different search term.' : 'Upload a spreadsheet to create your first validation template.'}
            </p>
            {!search && (
              <button
                onClick={() => navigate('/parse-template')}
                className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light"
              >
                Create Template
              </button>
            )}
          </div>
        )}

        {items.length > 0 && (
          <div className="space-y-2">
            {items.map(doc => (
              <Link
                key={doc.document_id}
                to={`/templates/${doc.document_id}`}
                className="flex items-center justify-between rounded-md border border-gray-200 bg-surface p-4 hover:bg-background hover:border-primary/40 transition-colors"
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-medium text-text truncate">{doc.data.name}</span>
                  {doc.data.description && (
                    <span className="text-xs text-text-muted truncate">{doc.data.description}</span>
                  )}
                </div>
                <div className="flex items-center gap-6 shrink-0 ml-4 text-xs text-text-muted">
                  {doc.data.column_count != null && (
                    <span>{doc.data.column_count} col{doc.data.column_count !== 1 ? 's' : ''}</span>
                  )}
                  <span>{new Date(doc.created_at).toLocaleDateString()}</span>
                  <span className="text-primary">→</span>
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* Pagination */}
        {pages > 1 && (
          <div className="mt-6 flex items-center justify-center gap-4">
            <button
              onClick={() => handlePageChange(page - 1)}
              disabled={page <= 1}
              className="rounded-md border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              ← Prev
            </button>
            <span className="text-sm text-text-muted">
              Page {page} of {pages}
            </span>
            <button
              onClick={() => handlePageChange(page + 1)}
              disabled={page >= pages}
              className="rounded-md border border-primary px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              Next →
            </button>
          </div>
        )}

      </main>
    </div>
  )
}
