import { toSlug } from './util.js'

const WIP_BASE = process.env.WIP_BASE_URL || 'https://localhost:8443'
export const WIP_NAMESPACE = process.env.WIP_NAMESPACE || 'wip-val'

function apiKey(): string {
  const key = process.env.WIP_API_KEY
  if (!key) throw new Error('WIP_API_KEY not set')
  return key
}

export async function wipFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${WIP_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WIP ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json() as T
}

// Unwrap a WIP bulk-first response (all write endpoints return {results: [...]} arrays).
function unwrapSingle<T>(bulk: { results: ({ status: string; error?: string } & T)[] }): T {
  const result = bulk.results[0]
  if (!result) throw new Error('WIP returned empty results array')
  if (result.status === 'error') throw new Error(result.error ?? 'WIP error (no message)')
  return result
}

export async function getTemplateIdByValue(namespace: string, value: string): Promise<string> {
  const data = await wipFetch<{ items: { template_id: string; value: string }[] }>(
    'GET',
    `/api/template-store/templates?namespace=${namespace}&page_size=100`
  )
  const match = data.items.find(t => t.value === value)
  if (!match) throw new Error(`Template '${value}' not found in namespace '${namespace}'`)
  return match.template_id
}

interface CreateDocResult {
  document_id: string
  status: string
}

export async function createDocument(
  templateId: string,
  namespace: string,
  data: Record<string, unknown>,
  createdBy?: string
): Promise<CreateDocResult> {
  const bulk = await wipFetch<{ results: (CreateDocResult & { error?: string })[] }>(
    'POST',
    '/api/document-store/documents',
    [{ template_id: templateId, namespace, data, created_by: createdBy }]
  )
  return unwrapSingle(bulk)
}

interface TerminologyResult {
  terminology_id: string
  value: string
}

export async function getOrCreateTerminology(
  namespace: string,
  value: string,
  label: string
): Promise<TerminologyResult> {
  const listData = await wipFetch<{ items: TerminologyResult[] }>(
    'GET',
    `/api/def-store/terminologies?namespace=${namespace}&page_size=200`
  )
  const existing = listData.items.find(t => t.value === value)
  if (existing) return existing

  const bulk = await wipFetch<{ results: { id: string; status: string; error?: string | null }[] }>(
    'POST',
    '/api/def-store/terminologies',
    [{ value, label, namespace, mutable: true, description: `LOV values for column "${label}"` }]
  )
  const r = bulk.results[0]
  if (!r) throw new Error('WIP returned empty results for terminology create')
  if (r.status === 'error') throw new Error(r.error ?? 'WIP terminology create error')
  return { terminology_id: r.id, value }
}

export async function upsertTerms(terminologyId: string, terms: string[]): Promise<void> {
  if (terms.length === 0) return

  const existingData = await wipFetch<{ items: { value: string }[]; total: number }>(
    'GET',
    `/api/def-store/terminologies/${terminologyId}/terms?page_size=1000`
  )
  const existingValues = new Set(existingData.items.map(t => t.value))

  const newTerms = terms
    .filter(v => v.trim() !== '')
    .filter(v => !existingValues.has(v.trim()))
    .map((v, i) => ({ value: v.trim(), sort_order: existingData.total + i + 1 }))

  if (newTerms.length === 0) return

  await wipFetch(
    'POST',
    `/api/def-store/terminologies/${terminologyId}/terms`,
    newTerms
  )
}

export function lovTerminologyValue(templateName: string, columnName: string): string {
  const tSlug = toSlug(templateName).toUpperCase()
  const cSlug = toSlug(columnName).toUpperCase()
  return `LOV_${tSlug}_${cSlug}`.slice(0, 80)
}

// Upload a file buffer to WIP's file store. Returns the file_id.
export async function uploadFileToWip(
  buffer: Buffer,
  filename: string,
  contentType: string,
  namespace: string
): Promise<{ file_id: string }> {
  const formData = new FormData()
  formData.append('file', new Blob([new Uint8Array(buffer)], { type: contentType }), filename)
  formData.append('namespace', namespace)
  formData.append('category', 'source_spreadsheet')

  const res = await fetch(`${WIP_BASE}/api/document-store/files`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey() },
    body: formData,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WIP file upload → ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json() as Promise<{ file_id: string }>
}

// Query documents with optional field filters and pagination.
export async function queryDocuments(
  templateId: string,
  namespace: string,
  options: {
    filters?: { field: string; operator: string; value: unknown }[]
    page?: number
    pageSize?: number
  } = {}
): Promise<{ items: Record<string, unknown>[]; total: number; pages: number }> {
  const { filters, page = 1, pageSize = 100 } = options
  const body: Record<string, unknown> = { template_id: templateId, page, page_size: pageSize }
  if (filters && filters.length > 0) body.filters = filters
  return wipFetch<{ items: Record<string, unknown>[]; total: number; pages: number }>(
    'POST',
    `/api/document-store/documents/query?namespace=${encodeURIComponent(namespace)}`,
    body
  )
}

// Get a single document by ID.
export async function getDocument(documentId: string): Promise<Record<string, unknown>> {
  return wipFetch<Record<string, unknown>>('GET', `/api/document-store/documents/${documentId}`)
}

// Get all active term values for a terminology as a Set (for fast LOV lookup).
export async function getTermValues(terminologyId: string): Promise<Set<string>> {
  const data = await wipFetch<{ items: { value: string }[] }>(
    'GET',
    `/api/def-store/terminologies/${terminologyId}/terms?page_size=1000`
  )
  return new Set(data.items.map(t => t.value))
}

// Soft-delete a single document.
export async function deleteDocument(documentId: string): Promise<void> {
  const res = await fetch(`${WIP_BASE}/api/document-store/documents/${documentId}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': apiKey() },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`WIP DELETE document ${documentId} → ${res.status}: ${text.slice(0, 300)}`)
  }
}

// Download a file from WIP's file store. Returns raw bytes and headers.
export async function downloadFile(
  fileId: string
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  // Try /download suffix first; WIP may also serve at the bare resource path.
  for (const path of [
    `/api/document-store/files/${fileId}/download`,
    `/api/document-store/files/${fileId}`,
  ]) {
    const res = await fetch(`${WIP_BASE}${path}`, {
      headers: { 'X-API-Key': apiKey() },
    })
    if (!res.ok) continue
    const ct = res.headers.get('Content-Type') ?? ''
    if (ct.includes('application/json')) continue  // metadata endpoint, not binary
    const disposition = res.headers.get('Content-Disposition') ?? ''
    const match = /filename[^;=\n]*=['"]?([^'"\n;]+)['"]?/.exec(disposition)
    const filename = match?.[1]?.trim() ?? fileId
    const buffer = Buffer.from(await res.arrayBuffer())
    return { buffer, contentType: ct || 'application/octet-stream', filename }
  }
  throw new Error(`Could not download file ${fileId} from WIP`)
}

// Patch fields on a single document (RFC 7396 merge patch).
export async function patchDocument(
  documentId: string,
  patch: Record<string, unknown>,
  namespace: string
): Promise<{ document_id: string; version: number }> {
  type R = { id: string; document_id: string; version: number; status: string; error?: string | null }
  const bulk = await wipFetch<{ results: R[] }>(
    'PATCH',
    `/api/document-store/documents?namespace=${encodeURIComponent(namespace)}`,
    [{ document_id: documentId, patch }]
  )
  const r = bulk.results[0]
  if (!r) throw new Error('WIP returned empty results for patch')
  if (r.status === 'error') throw new Error(r.error ?? 'WIP patch error')
  return { document_id: r.document_id, version: r.version }
}
