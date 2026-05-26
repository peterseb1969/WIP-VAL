import { createWipClient } from '@wip/client'
import { toSlug } from './util.js'

const WIP_BASE = process.env.WIP_BASE_URL || 'https://localhost:8443'
export const WIP_NAMESPACE = process.env.WIP_NAMESPACE || 'wip-val'

let _client: ReturnType<typeof createWipClient> | null = null

function wip() {
  if (_client) return _client
  const key = process.env.WIP_API_KEY
  if (!key) throw new Error('WIP_API_KEY not set')
  _client = createWipClient({ baseUrl: WIP_BASE, auth: { type: 'api-key', key } })
  return _client
}

export async function getTemplateIdByValue(namespace: string, value: string): Promise<string> {
  const list = await wip().templates.listTemplates({ namespace, page_size: 100 })
  const match = list.items.find(t => t.value === value)
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
  const r = await wip().documents.createDocument({
    template_id: templateId,
    namespace,
    data,
    created_by: createdBy,
  })
  if (!r.id) throw new Error('createDocument: no id in response')
  return { document_id: r.id, status: r.status }
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
  const list = await wip().defStore.listTerminologies({ namespace, value, page_size: 10 })
  const existing = list.items.find(t => t.value === value)
  if (existing) return { terminology_id: existing.terminology_id, value: existing.value }

  const r = await wip().defStore.createTerminology({
    value,
    label,
    namespace,
    mutable: true,
    description: `LOV values for column "${label}"`,
  })
  if (!r.id) throw new Error('createTerminology: no id in response')
  return { terminology_id: r.id, value }
}

export async function upsertTerms(terminologyId: string, namespace: string, terms: string[]): Promise<void> {
  if (terms.length === 0) return
  const existingData = await wip().defStore.listTerms(terminologyId, { page_size: 1000 })
  const existingValues = new Set(existingData.items.map(t => t.value))
  const newTerms = terms
    .filter(v => v.trim() !== '')
    .filter(v => !existingValues.has(v.trim()))
    .map((v, i) => ({ value: v.trim(), sort_order: existingData.total + i + 1 }))
  if (newTerms.length === 0) return
  await wip().defStore.createTerms(terminologyId, newTerms, { namespace })
}

export function lovTerminologyValue(templateName: string, columnName: string): string {
  const tSlug = toSlug(templateName).toUpperCase()
  const cSlug = toSlug(columnName).toUpperCase()
  return `LOV_${tSlug}_${cSlug}`.slice(0, 80)
}

export async function uploadFileToWip(
  buffer: Buffer,
  filename: string,
  contentType: string,
  namespace: string
): Promise<{ file_id: string }> {
  const blob = new Blob([new Uint8Array(buffer)], { type: contentType })
  const file = await wip().files.uploadFile(blob, filename, { category: 'source_spreadsheet' }, namespace)
  return { file_id: file.file_id }
}

export async function queryDocuments(
  templateId: string,
  _namespace: string,
  options: {
    filters?: { field: string; operator: string; value: unknown }[]
    page?: number
    pageSize?: number
  } = {}
): Promise<{ items: Record<string, unknown>[]; total: number; pages: number }> {
  const { filters, page = 1, pageSize = 100 } = options
  const result = await wip().documents.queryDocuments({
    template_id: templateId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    filters: filters as any,
    page,
    page_size: pageSize,
  })
  return {
    items: result.items as unknown as Record<string, unknown>[],
    total: result.total,
    pages: result.pages,
  }
}

export async function getDocument(documentId: string): Promise<Record<string, unknown>> {
  const doc = await wip().documents.getLatestDocument(documentId)
  return doc as unknown as Record<string, unknown>
}

export async function getTermValues(terminologyId: string): Promise<Set<string>> {
  const data = await wip().defStore.listTerms(terminologyId, { page_size: 1000 })
  return new Set(data.items.map(t => t.value))
}

export async function patchDocument(
  documentId: string,
  patch: Record<string, unknown>,
  _namespace: string
): Promise<{ document_id: string; version: number }> {
  const r = await wip().documents.updateDocument(documentId, patch)
  if (!r.id) throw new Error('updateDocument: no id in response')
  return { document_id: r.id, version: r.version ?? 0 }
}

export async function deleteDocument(documentId: string): Promise<void> {
  await wip().documents.deleteDocument(documentId)
}

// Returns a time-limited presigned MinIO URL — redirect the browser to it directly.
export async function getFileDownloadUrl(fileId: string): Promise<string> {
  const { download_url } = await wip().files.getDownloadUrl(fileId, 3600)
  return download_url
}
