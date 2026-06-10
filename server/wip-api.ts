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

// Raw client accessor for modules that need API surface not wrapped here
// (bootstrap uses registry/def-store/template-store directly).
export function wipClient() {
  return wip()
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

export interface WipValidationError {
  field: string | null
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface WipValidationResult {
  valid: boolean
  errors: WipValidationError[]
  warnings: string[]
}

// Dry-run validation against a WIP template — no document is persisted.
// Singular today (one call per row); the call site in validate.ts isolates it
// so the swap to a future bulk validateDocuments (CASE-419) is one place.
export async function validateWipDocument(
  templateId: string,
  namespace: string,
  data: Record<string, unknown>
): Promise<WipValidationResult> {
  const r = await wip().documents.validateDocument({
    template_id: templateId,
    namespace,
    data,
  })
  return {
    valid: r.valid,
    errors: (r.errors ?? []) as WipValidationError[],
    warnings: r.warnings ?? [],
  }
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

  // WIP deduplicates by checksum — if the file was previously soft-deleted,
  // the returned file_id is inactive and can't be referenced. Hard-delete it
  // so the next upload creates a fresh file.
  const meta = await wip().files.getFile(file.file_id)
  if (meta.status === 'inactive') {
    try {
      const baseUrl = process.env.WIP_BASE_URL || 'https://localhost:8443'
      const apiKey = process.env.WIP_API_KEY || ''
      await fetch(`${baseUrl}/api/files/${namespace}/${file.file_id}?hard=true`, {
        method: 'DELETE',
        headers: { 'X-API-Key': apiKey },
      })
    } catch { /* best-effort */ }
    // Re-upload — now that the old file is gone, WIP will create a new one
    const blob2 = new Blob([new Uint8Array(buffer)], { type: 'application/octet-stream' })
    const file2 = await wip().files.uploadFile(blob2, filename, { category: 'source_spreadsheet' }, namespace)
    return { file_id: file2.file_id }
  }

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

interface ValTemplateRow {
  document_id: string
  version: number
  created_at: string
  data: {
    name: string
    description: string
    field_count: number | null
    created_by: string | null
    source_file: string | null
    wip_template_id: string | null
    wip_template_value: string | null
    format: string | null
  }
}

function rowToValTemplate(row: unknown): ValTemplateRow {
  const r = row as unknown as Record<string, unknown>
  return {
    document_id: r['document_id'] as string,
    version: r['version'] as number,
    created_at: r['created_at'] as string,
    data: {
      name: r['name'] as string,
      description: (r['description'] as string | null) ?? '',
      field_count: (r['field_count'] as number | null) ?? (r['column_count'] as number | null),
      created_by: r['created_by'] as string | null,
      source_file: r['source_file_file_id'] as string | null,
      wip_template_id: r['wip_template_id'] as string | null,
      wip_template_value: r['wip_template_value'] as string | null,
      format: r['format'] as string | null,
    },
  }
}

const VAL_TEMPLATE_COLS = `
  document_id, name, description,
  field_count,
  data_created_by AS created_by,
  source_file_file_id, created_at, version,
  wip_template_id, wip_template_value, format`

export async function queryValTemplates(
  search: string,
  page: number,
  pageSize: number
): Promise<{ items: ValTemplateRow[]; total: number; pages: number }> {
  const offset = (page - 1) * pageSize
  const pattern = search ? `%${search.replace(/[%_]/g, '\\$&')}%` : '%'
  const [data, count] = await Promise.all([
    wip().reporting.runQuery(
      `SELECT ${VAL_TEMPLATE_COLS} FROM doc_val_template
       WHERE status = 'active' AND name ILIKE $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [pattern, pageSize, offset]
    ),
    wip().reporting.runQuery(
      `SELECT COUNT(*)::int AS total FROM doc_val_template
       WHERE status = 'active' AND name ILIKE $1`,
      [pattern]
    ),
  ])
  const total = (count.rows[0] as unknown as Record<string, unknown>)['total'] as number
  return {
    items: data.rows.map(r => rowToValTemplate(r)),
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  }
}

export async function getValTemplateDoc(id: string): Promise<ValTemplateRow> {
  const result = await wip().reporting.runQuery(
    `SELECT ${VAL_TEMPLATE_COLS} FROM doc_val_template
     WHERE document_id = $1 AND status = 'active' LIMIT 1`,
    [id]
  )
  if (result.rows.length === 0) throw new Error(`404: Template '${id}' not found`)
  return rowToValTemplate(result.rows[0])
}

export interface WipTemplateField {
  name: string
  label: string
  type: string
  mandatory: boolean
  terminology_ref?: string
  reference_type?: string
  semantic_type?: string
  default_value?: unknown
  validation?: { pattern?: string; minimum?: number; maximum?: number; min_length?: number; max_length?: number }
  metadata?: Record<string, unknown>
}

export interface WipTemplateRule {
  type: string
  description?: string
}

export async function getWipTemplate(templateId: string): Promise<{
  template_id: string
  value: string
  version: number
  usage?: string
  extends?: string | null
  rules: WipTemplateRule[]
  fields: WipTemplateField[]
  identity_fields: string[]
  metadata?: Record<string, unknown>
}> {
  const list = await wip().templates.listTemplates({ namespace: WIP_NAMESPACE, page_size: 200 })
  const match = list.items.find(t => t.template_id === templateId)
  if (!match) throw new Error(`WIP template '${templateId}' not found`)
  const m = match as unknown as Record<string, unknown>
  return {
    template_id: match.template_id,
    value: match.value,
    version: match.version,
    usage: m['usage'] as string | undefined,
    extends: (m['extends'] as string | null | undefined) ?? null,
    rules: (m['rules'] as WipTemplateRule[] | undefined) ?? [],
    fields: (match.fields as unknown as WipTemplateField[]) ?? [],
    identity_fields: match.identity_fields ?? [],
    metadata: match.metadata as unknown as Record<string, unknown> | undefined,
  }
}

// Like getWipTemplate but uses getTemplate(id) which returns RESOLVED fields
// (own + inherited). Required for export so inherited columns aren't dropped.
export async function getWipTemplateResolved(templateId: string): Promise<{
  template_id: string
  value: string
  label: string
  description: string
  version: number
  usage?: string
  extends?: string | null
  rules: WipTemplateRule[]
  fields: WipTemplateField[]
  identity_fields: string[]
  metadata?: Record<string, unknown>
}> {
  const t = (await wip().templates.getTemplate(templateId)) as unknown as Record<string, unknown>
  return {
    template_id: t['template_id'] as string,
    value: t['value'] as string,
    label: (t['label'] as string) ?? (t['value'] as string),
    description: (t['description'] as string) ?? '',
    version: t['version'] as number,
    usage: t['usage'] as string | undefined,
    extends: (t['extends'] as string | null | undefined) ?? null,
    rules: (t['rules'] as WipTemplateRule[] | undefined) ?? [],
    fields: (t['fields'] as unknown as WipTemplateField[]) ?? [],
    identity_fields: (t['identity_fields'] as string[] | undefined) ?? [],
    metadata: t['metadata'] as Record<string, unknown> | undefined,
  }
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
  return result.rows.map(row => {
    const r = row as unknown as Record<string, unknown>
    return {
      document_id: r['document_id'] as string,
      data: {
        column_name: r['column_name'] as string,
        display_name: r['display_name'] as string | null,
        column_index: r['column_index'] as number,
        column_type: r['column_type'] as string,
        required: r['required'] as boolean | null,
        lov_terminology: r['lov_terminology'] as string | null,
        description: r['description'] as string | null,
        pattern: r['pattern'] as string | null,
        min_value: r['min_value'] as number | null,
        max_value: r['max_value'] as number | null,
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
