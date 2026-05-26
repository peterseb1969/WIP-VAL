import multer from 'multer'
import * as XLSX from 'xlsx'
import type { Request, Response, RequestHandler } from 'express'
import {
  getDocument,
  queryDocuments,
  getTemplateIdByValue,
  getTermValues,
  WIP_NAMESPACE,
} from './wip-api.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ColumnSpec {
  column_name: string
  column_type: string
  required: boolean
  lov_terminology?: string
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

// ─── Validate a single spreadsheet buffer ────────────────────────────────────

function validateSheet(
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
      // 1. Load template document and VAL_COLUMN template ID in parallel
      const [templateDoc, colTemplateId] = await Promise.all([
        getDocument(templateId),
        getTemplateIdByValue(WIP_NAMESPACE, 'VAL_COLUMN'),
      ])

      // 2. Load all columns for this template
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

      // 3. Load LOV term sets in parallel (only for term-typed columns)
      const lovSets = new Map<string, Set<string>>()
      await Promise.all(
        columns
          .filter(c => c.column_type === 'term' && c.lov_terminology)
          .map(async c => {
            const values = await getTermValues(c.lov_terminology!)
            lovSets.set(c.column_name, values)
          })
      )

      // 4. Validate each uploaded file
      const templateData = (templateDoc as Record<string, unknown>)['data'] as Record<string, unknown>
      const results = files.map(f =>
        validateSheet(f.buffer, f.originalname, columns, lovSets)
      )

      const totalErrors = results.reduce((sum, r) => sum + r.errorCount, 0)

      const response: ValidationResponse = {
        templateName: (templateData['name'] as string) ?? 'Unknown',
        totalErrors,
        results,
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
