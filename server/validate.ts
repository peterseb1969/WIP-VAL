import multer from 'multer'
import * as XLSX from 'xlsx'
import type { Request, Response, RequestHandler } from 'express'
import {
  queryDocuments,
  getTemplateIdByValue,
  getTermValues,
  getValTemplateDoc,
  getWipTemplate,
  uploadFileToWip,
  createDocument,
  validateWipDocument,
  WIP_NAMESPACE,
} from './wip-api.js'
import type { WipTemplateField } from './wip-api.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ColumnSpec {
  column_name: string
  column_type: string
  required: boolean
  lov_terminology?: string
}

export interface ValidationError {
  row: number
  column: string
  value: string
  message: string
}

export interface FileResult {
  filename: string
  rowCount: number
  errorCount: number
  missingColumns: string[]
  errors: ValidationError[]
}

interface RunRef {
  document_id: string
  filename: string
}

interface ValidationResponse {
  templateName: string
  totalErrors: number
  results: FileResult[]
  runs?: RunRef[]
  persistenceError?: string
}

// ─── Type validators ──────────────────────────────────────────────────────────

const BOOL_SET = new Set(['true', 'false', 'yes', 'no', '1', '0', 'y', 'n'])
const MAX_ERRORS = 100

function validateValue(raw: string, colType: string, lovSet?: Set<string>): string | null {
  const v = raw.trim()
  switch (colType) {
    case 'integer':
      return /^-?\d+$/.test(v) ? null : `Expected integer, got "${raw}"`
    case 'number':
      return !isNaN(Number(v)) && v !== '' ? null : `Expected number, got "${raw}"`
    case 'boolean':
      return BOOL_SET.has(v.toLowerCase()) ? null : `Expected boolean (true/false/yes/no/1/0), got "${raw}"`
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : `Expected YYYY-MM-DD date, got "${raw}"`
    case 'datetime':
      return !isNaN(Date.parse(v)) ? null : `Expected valid datetime, got "${raw}"`
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : `Expected email address, got "${raw}"`
    case 'url':
      return /^https?:\/\//.test(v) ? null : `Expected https?:// URL, got "${raw}"`
    case 'term':
      if (!lovSet || lovSet.size === 0) return null
      return lovSet.has(v) ? null : `"${raw}" is not in the allowed value list`
    default:
      return null  // string: any value is valid
  }
}

// ─── WIP-delegated validation (new path) ─────────────────────────────────────
// Coerce a spreadsheet cell to its field's JS type ONLY when cleanly
// convertible; otherwise pass the raw value through so WIP rejects it. The
// coercion never hides an error — "12x" in an integer column reaches WIP as a
// string and fails there, which is the point: WIP semantics are the truth.
function coerce(cell: unknown, type: string): unknown {
  if (cell instanceof Date) {
    return type === 'date' ? cell.toISOString().slice(0, 10) : cell.toISOString()
  }
  const v = String(cell).trim()
  switch (type) {
    case 'integer': return /^-?\d+$/.test(v) ? Number(v) : v
    case 'number':  return v !== '' && isFinite(Number(v)) ? Number(v) : v
    case 'boolean':
      return /^(true|yes|1)$/i.test(v) ? true : /^(false|no|0)$/i.test(v) ? false : v
    default:        return v   // string / term / email / url — WIP validates
  }
}

// The single seam. One validateDocument call per row today; when the platform
// ships bulk validateDocuments (CASE-419) this is the only place that changes.
async function validateRow(wipTemplateId: string, data: Record<string, unknown>) {
  return validateWipDocument(wipTemplateId, WIP_NAMESPACE, data)
}

// ─── Validate a single spreadsheet buffer ────────────────────────────────────

export function validateSheet(
  buffer: Buffer,
  filename: string,
  columns: ColumnSpec[],
  lovSets: Map<string, Set<string>>
): FileResult {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  } catch {
    return {
      filename, rowCount: 0, errorCount: 1, missingColumns: [],
      errors: [{ row: 0, column: '', value: '', message: 'Could not parse file — ensure it is a valid .xlsx, .xls, or .csv' }],
    }
  }

  const sheetName = wb.SheetNames[0]
  const ws = sheetName ? wb.Sheets[sheetName] : undefined
  if (!ws) {
    return { filename, rowCount: 0, errorCount: 1, missingColumns: [],
      errors: [{ row: 0, column: '', value: '', message: 'Spreadsheet has no sheets' }] }
  }

  const rows = XLSX.utils.sheet_to_json<(string | number | boolean | Date | null)[]>(
    ws, { header: 1, defval: null }
  ) as (string | number | boolean | Date | null)[][]

  if (rows.length === 0) {
    return { filename, rowCount: 0, errorCount: 0, missingColumns: [], errors: [] }
  }

  const headerRow = (rows[0] ?? []).map(v => (v != null ? String(v).trim() : ''))
  const headerIndex = new Map<string, number>(headerRow.map((h, i) => [h, i]))
  const dataRows = rows.slice(1)

  const missingColumns = columns
    .filter(c => !headerIndex.has(c.column_name))
    .map(c => c.column_name)

  const errors: ValidationError[] = []

  for (let ri = 0; ri < dataRows.length; ri++) {
    if (errors.length >= MAX_ERRORS) break
    const row = dataRows[ri] ?? []
    const rowNum = ri + 2  // 1-indexed, row 1 is header

    for (const col of columns) {
      if (errors.length >= MAX_ERRORS) break

      const colIdx = headerIndex.get(col.column_name)
      if (colIdx === undefined) {
        // Column missing from spreadsheet — only surface per-row error for required cols
        if (col.required) {
          errors.push({ row: rowNum, column: col.column_name, value: '', message: 'Column missing from spreadsheet' })
        }
        continue
      }

      const rawCell = row[colIdx]
      const strValue = rawCell != null ? String(rawCell).trim() : ''

      if (col.required && strValue === '') {
        errors.push({ row: rowNum, column: col.column_name, value: '', message: 'Required — must not be empty' })
        continue
      }

      if (strValue !== '') {
        const err = validateValue(strValue, col.column_type, lovSets.get(col.column_name))
        if (err) {
          errors.push({ row: rowNum, column: col.column_name, value: strValue, message: err })
        }
      }
    }
  }

  return {
    filename,
    rowCount: dataRows.length,
    errorCount: errors.length,
    missingColumns,
    errors,
  }
}

// ─── Validate a single spreadsheet buffer via WIP (delegated) ────────────────
// Same parse / missing-column contract as validateSheet, but each row is sent
// to WIP as a document payload (keyed by field NAME) and validated there.
// Errors come back per-field; we map them back to the spreadsheet column
// (field LABEL) and row number to preserve the existing UI shape.
const CONCURRENCY = 8

async function validateSheetViaWip(
  buffer: Buffer,
  filename: string,
  wipTemplateId: string,
  fields: WipTemplateField[]
): Promise<FileResult> {
  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true })
  } catch {
    return {
      filename, rowCount: 0, errorCount: 1, missingColumns: [],
      errors: [{ row: 0, column: '', value: '', message: 'Could not parse file — ensure it is a valid .xlsx, .xls, or .csv' }],
    }
  }

  const sheetName = wb.SheetNames[0]
  const ws = sheetName ? wb.Sheets[sheetName] : undefined
  if (!ws) {
    return { filename, rowCount: 0, errorCount: 1, missingColumns: [],
      errors: [{ row: 0, column: '', value: '', message: 'Spreadsheet has no sheets' }] }
  }

  const rows = XLSX.utils.sheet_to_json<(string | number | boolean | Date | null)[]>(
    ws, { header: 1, defval: null }
  ) as (string | number | boolean | Date | null)[][]

  if (rows.length === 0) {
    return { filename, rowCount: 0, errorCount: 0, missingColumns: [], errors: [] }
  }

  const headerRow = (rows[0] ?? []).map(v => (v != null ? String(v).trim() : ''))
  const headerIndex = new Map<string, number>(headerRow.map((h, i) => [h, i]))
  const dataRows = rows.slice(1)

  // Header ↔ field join is on LABEL (the spreadsheet header); the document
  // payload is keyed by NAME (the slug). Both live on every template field.
  const presentFields = fields.filter(f => headerIndex.has(f.label))
  const missingColumns = fields.filter(f => !headerIndex.has(f.label)).map(f => f.label)
  // Mandatory columns absent from the sheet are reported once (missingColumns);
  // suppress the identical per-row "field required" flood WIP would emit.
  const missingFieldNames = new Set(fields.filter(f => !headerIndex.has(f.label)).map(f => f.name))
  const nameToLabel = new Map(fields.map(f => [f.name, f.label]))

  const errors: ValidationError[] = []

  for (let start = 0; start < dataRows.length && errors.length < MAX_ERRORS; start += CONCURRENCY) {
    const chunk = dataRows.slice(start, start + CONCURRENCY)
    const validated = await Promise.all(
      chunk.map(async (row, j) => {
        const rowNum = start + j + 2  // 1-indexed, row 1 is header
        const data: Record<string, unknown> = {}
        for (const f of presentFields) {
          const cell = (row ?? [])[headerIndex.get(f.label)!]
          if (cell != null && String(cell).trim() !== '') {
            data[f.name] = coerce(cell, f.type)
          }
        }
        const res = await validateRow(wipTemplateId, data)
        return { rowNum, data, res }
      })
    )

    for (const { rowNum, data, res } of validated) {
      if (errors.length >= MAX_ERRORS) break
      if (res.valid) continue
      for (const e of res.errors) {
        if (errors.length >= MAX_ERRORS) break
        if (e.field && missingFieldNames.has(e.field)) continue  // already in missingColumns
        const column = e.field ? (nameToLabel.get(e.field) ?? e.field) : ''
        const value = e.field ? String(data[e.field] ?? '') : ''
        errors.push({ row: rowNum, column, value, message: e.message })
      }
    }
  }

  return {
    filename,
    rowCount: dataRows.length,
    errorCount: errors.length,
    missingColumns,
    errors,
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage() })

export function createValidateHandler(): RequestHandler[] {
  const middleware = upload.array('files', 20)

  const handler = async (req: Request, res: Response): Promise<void> => {
    const { templateId } = req.body as { templateId?: string }
    const files = req.files as Express.Multer.File[] | undefined

    if (!templateId) {
      res.status(400).json({ error: 'templateId is required' })
      return
    }
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'At least one file is required' })
      return
    }

    try {
      // Load VAL_TEMPLATE doc to check if it has a linked WIP template
      const valTemplate = await getValTemplateDoc(templateId)
      let results: FileResult[]

      if (valTemplate.data.wip_template_id) {
        // New path: delegate validation to WIP (single source of validation
        // truth) — each row is validated as a document against the WIP template.
        const wipTemplate = await getWipTemplate(valTemplate.data.wip_template_id)
        results = await Promise.all(
          files.map(f =>
            validateSheetViaWip(f.buffer, f.originalname, wipTemplate.template_id, wipTemplate.fields)
          )
        )
      } else {
        // Legacy path: local validation against VAL_COLUMN specs
        const lovSets = new Map<string, Set<string>>()
        const colTemplateId = await getTemplateIdByValue(WIP_NAMESPACE, 'VAL_COLUMN')
        const colsResult = await queryDocuments(colTemplateId, WIP_NAMESPACE, {
          filters: [{ field: 'data.template', operator: 'eq', value: templateId }],
          pageSize: 100,
        })

        const columns: ColumnSpec[] = colsResult.items
          .sort((a, b) => {
            const aIdx = ((a as Record<string, unknown>)['data'] as Record<string, unknown>)['column_index'] as number ?? 0
            const bIdx = ((b as Record<string, unknown>)['data'] as Record<string, unknown>)['column_index'] as number ?? 0
            return aIdx - bIdx
          })
          .map(item => {
            const d = (item as Record<string, unknown>)['data'] as Record<string, unknown>
            return {
              column_name: d['column_name'] as string,
              column_type: d['column_type'] as string,
              required: (d['required'] as boolean) ?? false,
              lov_terminology: d['lov_terminology'] as string | undefined,
            }
          })

        await Promise.all(
          columns
            .filter(c => c.column_type === 'term' && c.lov_terminology)
            .map(async c => {
              const values = await getTermValues(c.lov_terminology!)
              lovSets.set(c.column_name, values)
            })
        )

        // Validate each uploaded file locally
        results = files.map(f =>
          validateSheet(f.buffer, f.originalname, columns, lovSets)
        )
      }

      const totalErrors = results.reduce((sum, r) => sum + r.errorCount, 0)

      // Persist each file as a VAL_RUN document (best-effort)
      let runs: RunRef[] | undefined
      let persistenceError: string | undefined
      try {
        const valRunTemplateId = await getTemplateIdByValue(WIP_NAMESPACE, 'VAL_RUN')
        runs = await Promise.all(
          files.map(async (f, i) => {
            const result = results[i]!
            const { file_id } = await uploadFileToWip(
              f.buffer, f.originalname,
              f.mimetype || 'application/octet-stream',
              WIP_NAMESPACE,
            )
            const doc = await createDocument(valRunTemplateId, WIP_NAMESPACE, {
              source_file: file_id,
              source_filename: f.originalname,
              template: templateId,
              run_status: 'complete',
              row_count: result.rowCount,
              error_count: result.errorCount,
              warning_count: 0,
              run_at: new Date().toISOString(),
              run_by: 'wip-val',
            })
            return { document_id: doc.document_id, filename: f.originalname }
          })
        )
      } catch (err: unknown) {
        persistenceError = err instanceof Error ? err.message : 'Failed to persist validation runs'
        console.error('Persistence error:', persistenceError)
      }

      const response: ValidationResponse = {
        templateName: valTemplate.data.name,
        totalErrors,
        results,
        runs,
        persistenceError,
      }

      res.json(response)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Validate error:', message)
      const status = message.includes('404') ? 404 : 500
      res.status(status).json({ error: message })
    }
  }

  return [middleware, handler as RequestHandler]
}
