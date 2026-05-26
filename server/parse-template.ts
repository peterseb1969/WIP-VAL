import multer from 'multer'
import * as XLSX from 'xlsx'
import type { Request, Response, RequestHandler } from 'express'
import {
  getTemplateIdByValue,
  createDocument,
  getOrCreateTerminology,
  upsertTerms,
  lovTerminologyValue,
  uploadFileToWip,
  WIP_NAMESPACE,
} from './wip-api.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ColumnType =
  | 'string' | 'number' | 'integer' | 'boolean'
  | 'date' | 'datetime' | 'email' | 'url' | 'term'

export interface ColumnGuess {
  columnIndex: number
  columnName: string
  guessedType: ColumnType
  required: boolean
  uniqueValueCount: number
  sampleValues: string[]
  lovValues?: string[]
  lovFromSheet?: string
}

export interface ParseResult {
  suggestedName: string
  rowCount: number
  sheets: string[]
  columns: ColumnGuess[]
  wipFileId?: string    // file_id from WIP file store if upload succeeded
  wipFileWarning?: string
}

export interface ApprovedColumn {
  columnIndex: number
  columnName: string
  displayName: string
  columnType: ColumnType
  required: boolean
  pattern?: string
  minValue?: number
  maxValue?: number
  lovValues?: string[]
  description?: string
}

export interface SaveRequest {
  templateName: string
  templateDescription: string
  columns: ApprovedColumn[]
  wipFileId?: string
}

// ─── Type guessing ────────────────────────────────────────────────────────────

const BOOL_SET = new Set(['true', 'false', 'yes', 'no', '1', '0', 'y', 'n'])

function guessType(values: string[], hasExplicitLov: boolean): ColumnType {
  if (hasExplicitLov) return 'term'
  const nonEmpty = values.filter(v => v != null && String(v).trim() !== '')
  if (nonEmpty.length === 0) return 'string'
  const trimmed = nonEmpty.map(v => String(v).trim())
  const lower = trimmed.map(v => v.toLowerCase())

  if (lower.every(v => BOOL_SET.has(v))) return 'boolean'
  if (trimmed.every(v => /^-?\d+$/.test(v))) return 'integer'
  if (trimmed.every(v => !isNaN(Number(v)) && v !== '')) return 'number'
  if (trimmed.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v))) return 'date'
  if (trimmed.every(v => (v.includes('T') || v.includes(':')) && !isNaN(Date.parse(v)))) return 'datetime'
  if (trimmed.every(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return 'email'
  if (trimmed.every(v => /^https?:\/\//.test(v))) return 'url'

  const unique = new Set(trimmed)
  if (unique.size <= 20) return 'term'

  return 'string'
}

// ─── LOV sheet parsing ────────────────────────────────────────────────────────

// Returns a map: columnName → LOV values[], covering both sheet formats:
//  1. Validation-column sheet: row 0 = data column headers, each col = LOV for that header
//  2. Named sheet: sheet name matches a data column name
function extractLovSheets(wb: XLSX.WorkBook, dataHeaders: string[]): Map<string, { values: string[]; sheetName: string }> {
  const headerSet = new Set(dataHeaders)
  const lovMap = new Map<string, { values: string[]; sheetName: string }>()

  for (const sheetName of wb.SheetNames.slice(1)) {
    const ws = wb.Sheets[sheetName]
    if (!ws) continue
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1, defval: null }) as (string | number | null)[][]
    if (rows.length === 0) continue

    const firstRow = (rows[0] ?? []).map(v => (v != null ? String(v).trim() : ''))

    // Validation-column sheet: ≥1 cell in row 0 matches a data header
    const isValidationSheet = firstRow.some(v => v !== '' && headerSet.has(v))
    if (isValidationSheet) {
      for (let col = 0; col < firstRow.length; col++) {
        const colHeader = firstRow[col]
        if (!colHeader || !headerSet.has(colHeader)) continue
        const vals = rows
          .slice(1)
          .map(r => (r[col] != null ? String(r[col]).trim() : ''))
          .filter(v => v !== '')
        if (vals.length > 0) {
          lovMap.set(colHeader, { values: vals, sheetName })
        }
      }
      continue
    }

    // Named sheet: sheet name matches a data column name exactly
    if (headerSet.has(sheetName)) {
      // Collect all non-null values from column A (index 0)
      const vals = rows
        .flatMap(r => (r[0] != null ? [String(r[0]).trim()] : []))
        .filter(v => v !== '')
      if (vals.length > 0) {
        lovMap.set(sheetName, { values: vals, sheetName })
      }
    }
  }

  return lovMap
}

// ─── Cell color helper ────────────────────────────────────────────────────────

// Returns true when the header cell for the given column index has red font.
// SheetJS stores font color as ARGB hex (e.g. "FFFF0000") or plain RGB ("FF0000").
// Thresholds: R > 180, G < 80, B < 80 — covers Excel's standard reds (FF0000, C00000).
function isHeaderCellRed(ws: XLSX.WorkSheet, colIndex: number): boolean {
  const addr = XLSX.utils.encode_cell({ r: 0, c: colIndex })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rgb: string | undefined = (ws[addr] as any)?.s?.font?.color?.rgb
  if (!rgb || rgb.length < 6) return false
  const hex = rgb.length === 8 ? rgb.slice(2) : rgb  // strip alpha if ARGB
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return r > 180 && g < 80 && b < 80
}

// ─── Parse handler ─────────────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage() })

export function createUploadHandler(): RequestHandler[] {
  const middleware = upload.single('file')

  const handler = async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' })
      return
    }

    try {
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true, cellStyles: true })
      const dataSheetName = wb.SheetNames[0]
      const ws = wb.Sheets[dataSheetName ?? '']

      if (!ws || !dataSheetName) {
        res.status(422).json({ error: 'Spreadsheet has no sheets' })
        return
      }

      const rows = XLSX.utils.sheet_to_json<(string | number | boolean | Date | null)[]>(
        ws, { header: 1, defval: null }
      ) as (string | number | boolean | Date | null)[][]

      if (rows.length < 1) {
        res.status(422).json({ error: 'Spreadsheet appears to be empty' })
        return
      }

      const headers = (rows[0] ?? []).map(v => (v != null ? String(v).trim() : ''))
      const dataRows = rows.slice(1)
      const lovMap = extractLovSheets(wb, headers)

      const columns: ColumnGuess[] = headers.map((colName, idx) => {
        const colValues = dataRows.map(r => (r[idx] != null ? String(r[idx]).trim() : ''))
        const nonEmpty = colValues.filter(v => v !== '')
        const lov = lovMap.get(colName)

        const guessedType = guessType(colValues, lov !== undefined)
        const uniqueStrings = [...new Set(nonEmpty)]

        const sampleValues = (lov?.values ?? uniqueStrings).slice(0, 8)
        const lovValues = guessedType === 'term'
          ? (lov?.values ?? uniqueStrings)
          : undefined

        return {
          columnIndex: idx,
          columnName: colName,
          guessedType,
          required: isHeaderCellRed(ws, idx),
          uniqueValueCount: uniqueStrings.length,
          sampleValues,
          lovValues,
          lovFromSheet: lov?.sheetName,
        }
      })

      const suggestedName = req.file.originalname.replace(/\.[^.]+$/, '')

      // Upload the source file to WIP — non-fatal if it fails
      let wipFileId: string | undefined
      let wipFileWarning: string | undefined
      try {
        const uploaded = await uploadFileToWip(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype || 'application/octet-stream',
          WIP_NAMESPACE
        )
        wipFileId = uploaded.file_id
      } catch (uploadErr: unknown) {
        wipFileWarning = uploadErr instanceof Error ? uploadErr.message : String(uploadErr)
        console.warn('WIP file upload failed (non-fatal):', wipFileWarning)
      }

      const result: ParseResult = {
        suggestedName,
        rowCount: dataRows.length,
        sheets: wb.SheetNames,
        columns,
        wipFileId,
        wipFileWarning,
      }

      res.json(result)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Parse error:', message)
      res.status(500).json({ error: `Failed to parse spreadsheet: ${message}` })
    }
  }

  return [middleware, handler as RequestHandler]
}

// ─── Save handler ─────────────────────────────────────────────────────────────

export function createSaveHandler(): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const { templateName, templateDescription, columns, wipFileId } = req.body as SaveRequest

    if (!templateName) {
      res.status(400).json({ error: 'templateName is required' })
      return
    }
    if (!Array.isArray(columns) || columns.length === 0) {
      res.status(400).json({ error: 'columns must be a non-empty array' })
      return
    }

    try {
      const createdBy = (req.session as { user?: { email?: string } })?.user?.email ?? 'wip-val'

      // 1. Get template IDs
      const [valTemplateId, valColumnId] = await Promise.all([
        getTemplateIdByValue(WIP_NAMESPACE, 'VAL_TEMPLATE'),
        getTemplateIdByValue(WIP_NAMESPACE, 'VAL_COLUMN'),
      ])

      // 2. Create/upsert VAL_TEMPLATE document
      const templateData: Record<string, unknown> = {
        name: templateName,
        description: templateDescription || '',
        column_count: columns.length,
        created_by: createdBy,
      }
      if (wipFileId) templateData.source_file = wipFileId

      const templateDoc = await createDocument(valTemplateId, WIP_NAMESPACE, templateData, createdBy)

      // 3. For each term column: create/upsert mutable LOV terminology
      const terminologiesCreated: string[] = []
      const lovTermIds: Record<number, string> = {}

      const termColumns = columns.filter(c => c.columnType === 'term' && (c.lovValues?.length ?? 0) > 0)
      await Promise.all(
        termColumns.map(async col => {
          const termValue = lovTerminologyValue(templateName, col.columnName)
          const term = await getOrCreateTerminology(
            WIP_NAMESPACE,
            termValue,
            col.displayName || col.columnName
          )
          await upsertTerms(term.terminology_id, col.lovValues ?? [])
          lovTermIds[col.columnIndex] = term.terminology_id
          terminologiesCreated.push(termValue)
        })
      )

      // 4. Create VAL_COLUMN documents in parallel (each has a unique column_name — no identity conflicts)
      await Promise.all(columns.map(col => {
        const data: Record<string, unknown> = {
          template: templateDoc.document_id,
          column_name: col.columnName,
          display_name: col.displayName || col.columnName,
          column_index: col.columnIndex,
          column_type: col.columnType,
          required: col.required,
          description: col.description || '',
        }
        if (col.pattern) data.pattern = col.pattern
        if (col.minValue != null) data.min_value = col.minValue
        if (col.maxValue != null) data.max_value = col.maxValue
        if (lovTermIds[col.columnIndex]) data.lov_terminology = lovTermIds[col.columnIndex]

        return createDocument(valColumnId, WIP_NAMESPACE, data, createdBy)
      }))

      res.json({
        templateDocumentId: templateDoc.document_id,
        columnCount: columns.length,
        terminologiesCreated,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Save error:', message)
      res.status(500).json({ error: `Failed to save template: ${message}` })
    }
  }
}
