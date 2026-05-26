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

const _templateIdCache = new Map<string, string>()

export async function getTemplateIdByValue(namespace: string, value: string): Promise<string> {
  const key = `${namespace}:${value}`
  const cached = _templateIdCache.get(key)
  if (cached) return cached
  const list = await wip().templates.listTemplates({ namespace, page_size: 100 })
  const match = list.items.find(t => t.value === value)
  if (!match) throw new Error(`Template '${value}' not found in namespace '${namespace}'`)
  _templateIdCache.set(key, match.template_id)
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
  _contentType: string,
  namespace: string
): Promise<{ file_id: string }> {
  // WIP file store wildcard MIME matching is broken (CASE-60) — upload as
  // octet-stream which is always accepted, and allow it on the template field.
  const blob = new Blob([new Uint8Array(buffer)], { type: 'application/octet-stream' })
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

interface ColumnRow {
  document_id: string
  data: {
    column_name: string
    display_name: string | null
    column_index: number
    column_type: string
    required: boolean | null
    lov_terminology: string | null
    description: string | null
    pattern: string | null
    min_value: number | null
    max_value: number | null
  }
}

export async function queryColumnsForTemplate(templateDocId: string): Promise<ColumnRow[]> {
  const result = await wip().reporting.runQuery(
    `SELECT document_id, column_name, display_name, column_index, column_type,
            required, lov_terminology, description, pattern, min_value, max_value
     FROM doc_val_column
     WHERE template = $1 AND status = 'active'
     ORDER BY column_index`,
    [templateDocId]
  )
  const cols = result.columns
  return result.rows.map(row => {
    const r = row as unknown[]
    const get = (name: string) => r[cols.indexOf(name)]
    return {
      document_id: get('document_id') as string,
      data: {
        column_name: get('column_name') as string,
        display_name: get('display_name') as string | null,
        column_index: get('column_index') as number,
        column_type: get('column_type') as string,
        required: get('required') as boolean | null,
        lov_terminology: get('lov_terminology') as string | null,
        description: get('description') as string | null,
        pattern: get('pattern') as string | null,
        min_value: get('min_value') as number | null,
        max_value: get('max_value') as number | null,
      },
    }
  })
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

export async function downloadFile(fileId: string): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const [blob, meta] = await Promise.all([
    wip().files.downloadFileContent(fileId),
    wip().files.getFile(fileId),
  ])
  const buffer = Buffer.from(await blob.arrayBuffer())
  return {
    buffer,
    contentType: meta.content_type || 'application/octet-stream',
    filename: meta.filename || fileId,
  }
}
