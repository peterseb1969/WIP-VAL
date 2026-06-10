import * as XLSX from 'xlsx'
import { toLowerSlug, toSlug } from '../util.js'
import type { ParsedTemplate, ParsedField, WipFieldType, SemanticType } from '../parsed-template.js'

// ─── Type guessing ───────────────────────────────────────────────────────────

const BOOL_SET = new Set(['true', 'false', 'yes', 'no', '1', '0', 'y', 'n'])

function guessType(values: string[], hasExplicitLov: boolean): { type: WipFieldType; semantic?: SemanticType } {
  if (hasExplicitLov) return { type: 'term' }
  const nonEmpty = values.filter(v => v != null && String(v).trim() !== '')
  if (nonEmpty.length === 0) return { type: 'string' }
  const trimmed = nonEmpty.map(v => String(v).trim())
  const lower = trimmed.map(v => v.toLowerCase())

  if (lower.every(v => BOOL_SET.has(v))) return { type: 'boolean' }
  if (trimmed.every(v => /^-?\d+$/.test(v))) return { type: 'integer' }
  if (trimmed.every(v => !isNaN(Number(v)) && v !== '')) return { type: 'number' }
  if (trimmed.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v))) return { type: 'date' }
  if (trimmed.every(v => (v.includes('T') || v.includes(':')) && !isNaN(Date.parse(v)))) return { type: 'datetime' }
  if (trimmed.every(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) return { type: 'string', semantic: 'email' }
  if (trimmed.every(v => /^https?:\/\//.test(v))) return { type: 'string', semantic: 'url' }

  const unique = new Set(trimmed)
  if (unique.size <= 20) return { type: 'term' }

  return { type: 'string' }
}

// ─── LOV sheet parsing ───────────────────────────────────────────────────────

function extractLovSheets(wb: XLSX.WorkBook, dataHeaders: string[]): Map<string, { values: string[]; sheetName: string }> {
  const headerSet = new Set(dataHeaders)
  const lovMap = new Map<string, { values: string[]; sheetName: string }>()

  for (const sheetName of wb.SheetNames.slice(1)) {
    const ws = wb.Sheets[sheetName]
    if (!ws) continue
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1, defval: null }) as (string | number | null)[][]
    if (rows.length === 0) continue

    const firstRow = (rows[0] ?? []).map(v => (v != null ? String(v).trim() : ''))

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

    if (headerSet.has(sheetName)) {
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

// ─── Cell color helper ───────────────────────────────────────────────────────

function isHeaderCellRed(ws: XLSX.WorkSheet, colIndex: number): boolean {
  const addr = XLSX.utils.encode_cell({ r: 0, c: colIndex })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rgb: string | undefined = (ws[addr] as any)?.s?.font?.color?.rgb
  if (!rgb || rgb.length < 6) return false
  const hex = rgb.length === 8 ? rgb.slice(2) : rgb
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return r > 180 && g < 80 && b < 80
}

// ─── C02 parser ──────────────────────────────────────────────────────────────

export function parseC02(wb: XLSX.WorkBook, fileInfo: { wipFileId?: string; wipFileWarning?: string }): ParsedTemplate {
  const dataSheetName = wb.SheetNames[0]
  const ws = wb.Sheets[dataSheetName ?? '']
  if (!ws || !dataSheetName) {
    throw new Error('Spreadsheet has no sheets')
  }

  const rows = XLSX.utils.sheet_to_json<(string | number | boolean | Date | null)[]>(
    ws, { header: 1, defval: null }
  ) as (string | number | boolean | Date | null)[][]

  if (rows.length < 1) {
    throw new Error('Spreadsheet appears to be empty')
  }

  const headers = (rows[0] ?? []).map(v => (v != null ? String(v).trim() : ''))
  const dataRows = rows.slice(1)
  const lovMap = extractLovSheets(wb, headers)

  const fields: ParsedField[] = headers
    .filter(h => h !== '')
    .map((colName, idx) => {
      const colValues = dataRows.map(r => (r[idx] != null ? String(r[idx]).trim() : ''))
      const nonEmpty = colValues.filter(v => v !== '')
      const lov = lovMap.get(colName)

      const { type, semantic } = guessType(colValues, lov !== undefined)
      const uniqueStrings = [...new Set(nonEmpty)]

      const terminologyValues = type === 'term'
        ? (lov?.values ?? uniqueStrings)
        : undefined

      return {
        name: toLowerSlug(colName),
        label: colName,
        type,
        mandatory: isHeaderCellRed(ws, idx),
        semanticType: semantic,
        terminologyValues,
        // No terminologyName: c02 LOVs share one "Validation Sheet", so the
        // sheet name would collapse every term field into a single terminology.
        // Leaving it unset makes save-template fall back to the per-field
        // LOV_<TEMPLATE>_<FIELD> naming.
        terminologyName: undefined,
      } satisfies ParsedField
    })

  const suggestedName = dataSheetName
  return {
    suggestedName,
    suggestedValue: toSlug(suggestedName),
    description: '',
    format: 'c02',
    fields,
    identityFields: [],
    rowCount: dataRows.length,
    sheets: wb.SheetNames,
    wipFileId: fileInfo.wipFileId,
    wipFileWarning: fileInfo.wipFileWarning,
    detectedFormat: 'c02',
  }
}
