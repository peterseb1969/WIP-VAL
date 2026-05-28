import * as XLSX from 'xlsx'
import { toLowerSlug, toSlug } from '../util.js'
import type { ParsedTemplate, ParsedField, WipFieldType } from '../parsed-template.js'

// Row labels in Column A that we search for (case-insensitive partial match)
const ROW_LABELS = {
  pbsFieldName: 'pbs field name',
  customerFieldName: 'customer field name',
  pattern: 'pattern',
  codeList: 'code list',
  fieldCategory: 'field category',
  parentCategory: 'parent category',
  definition: 'definition',
  duplicable: 'ability to duplicate',
  example: 'example',
  synonyms: 'synonyms',
} as const

interface RowIndices {
  pbsFieldName: number
  customerFieldName: number
  pattern: number
  codeList: number
  fieldCategory: number
  parentCategory: number
  definition: number
  duplicable: number
  example: number
  synonyms: number
}

function findRowIndices(rows: (string | number | null)[][]): Partial<RowIndices> {
  const indices: Partial<RowIndices> = {}
  for (let r = 0; r < rows.length; r++) {
    const cellA = rows[r]?.[0]
    if (cellA == null) continue
    const label = String(cellA).trim().toLowerCase()
    for (const [key, search] of Object.entries(ROW_LABELS)) {
      if (label.includes(search)) {
        (indices as Record<string, number>)[key] = r
      }
    }
  }
  return indices
}

function inferTypeFromPattern(pattern: string | undefined, hasCodeList: boolean): WipFieldType {
  if (hasCodeList) return 'term'
  if (!pattern || pattern === '{}' || pattern.trim() === '') return 'string'
  if (/\\d\{4\}.*\\d\{2\}.*\\d\{2\}/.test(pattern) || /yyyy/i.test(pattern)) return 'date'
  if (/^\^[\[(]?\\d/.test(pattern) || /^\^-\?\\d/.test(pattern)) return 'integer'
  if (/^\^\(Y\|N\)/i.test(pattern) || /^\^\(true\|false\)/i.test(pattern)) return 'boolean'
  return 'string'
}

function readLovSheet(wb: XLSX.WorkBook): Map<string, string[]> {
  const lovMap = new Map<string, string[]>()
  const lovSheetName = wb.SheetNames.find(s => s.toLowerCase().includes('lov'))
  if (!lovSheetName) return lovMap

  const ws = wb.Sheets[lovSheetName]
  if (!ws) return lovMap

  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1, defval: null }) as (string | number | null)[][]
  if (rows.length < 2) return lovMap

  const headers = (rows[0] ?? []).map(v => (v != null ? String(v).trim() : ''))
  for (let col = 0; col < headers.length; col++) {
    const name = headers[col]
    if (!name) continue
    const values: string[] = []
    for (let r = 1; r < rows.length; r++) {
      const cell = rows[r]?.[col]
      if (cell != null) {
        const v = String(cell).trim()
        if (v !== '') values.push(v)
      }
    }
    if (values.length > 0) lovMap.set(name, values)
  }
  return lovMap
}

function lookupLov(lovMap: Map<string, string[]>, codeListName: string): string[] | undefined {
  if (lovMap.has(codeListName)) return lovMap.get(codeListName)

  // Strip common prefixes (e.g., "PBS Datastore Sex" → "Sex")
  const stripped = codeListName.replace(/^PBS\s+Datastore\s+/i, '').trim()
  if (lovMap.has(stripped)) return lovMap.get(stripped)

  // Normalize: compare with underscores ↔ spaces
  const normalize = (s: string) => s.toLowerCase().replace(/[_\s]+/g, ' ').trim()
  const target = normalize(stripped)
  for (const [key, values] of lovMap) {
    if (normalize(key) === target) return values
  }

  return undefined
}

function readKeyValueSheet(wb: XLSX.WorkBook, sheetNamePattern: string): Record<string, string> {
  const result: Record<string, string> = {}
  const sheetName = wb.SheetNames.find(s => s.toLowerCase().includes(sheetNamePattern.toLowerCase()))
  if (!sheetName) return result

  const ws = wb.Sheets[sheetName]
  if (!ws) return result

  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1, defval: null }) as (string | number | null)[][]

  // Key-value sheets have headers in row 0, values in subsequent rows
  // Or they may be structured as col A = key, col B = value
  if (rows.length < 1) return result

  const headers = (rows[0] ?? []).map(v => (v != null ? String(v).trim() : ''))

  if (rows.length >= 2) {
    // Try column-per-attribute format: row 0 = headers, row 1 = values
    const values = rows[1] ?? []
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i]
      const val = values[i]
      if (key && val != null) {
        result[key] = String(val).trim()
      }
    }
  }

  return result
}

export function parseVendor(wb: XLSX.WorkBook, fileInfo: { wipFileId?: string; wipFileWarning?: string }): ParsedTemplate {
  const dataSheetName = wb.SheetNames[0]
  const ws = wb.Sheets[dataSheetName ?? '']
  if (!ws || !dataSheetName) {
    throw new Error('Vendor spreadsheet has no data sheet')
  }

  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1, defval: null }) as (string | number | null)[][]
  const indices = findRowIndices(rows)

  if (indices.pbsFieldName === undefined) {
    throw new Error('Could not find "PBS Field Name" row in the vendor spreadsheet')
  }

  const lovMap = readLovSheet(wb)
  const templateMeta = readKeyValueSheet(wb, 'template meta information')
  const datasetMeta = readKeyValueSheet(wb, 'dataset meta information')

  // Extract identity field names from Identifier Pattern (resolved after field loop)
  const identifierPattern = datasetMeta['Identifier Pattern'] ?? datasetMeta['IdentifierPattern'] ?? ''
  const rawIdentityNames = identifierPattern
    ? [...identifierPattern.matchAll(/\(\?<([^>]+)>/g)].map(m => m[1]!)
    : []

  // Determine last non-empty column (starting from B = index 1)
  const pbsRow = rows[indices.pbsFieldName] ?? []
  let lastCol = 0
  for (let c = 1; c < pbsRow.length; c++) {
    if (pbsRow[c] != null && String(pbsRow[c]).trim() !== '') lastCol = c
  }

  const fields: ParsedField[] = []
  for (let col = 1; col <= lastCol; col++) {
    const pbsName = cellStr(rows, indices.pbsFieldName, col)
    if (!pbsName) continue

    const customerName = cellStr(rows, indices.customerFieldName, col)
    const pattern = cellStr(rows, indices.pattern, col)
    const codeList = cellStr(rows, indices.codeList, col)
    const category = cellStr(rows, indices.fieldCategory, col)
    const parentCategory = cellStr(rows, indices.parentCategory, col)
    const definition = cellStr(rows, indices.definition, col)
    const duplicable = cellStr(rows, indices.duplicable, col)
    const example = cellStr(rows, indices.example, col)
    const synonyms = cellStr(rows, indices.synonyms, col)

    const hasCodeList = codeList !== ''
    const terminologyValues = hasCodeList ? (lookupLov(lovMap, codeList) ?? []) : undefined
    const cleanPattern = (pattern === '{}' || pattern === '') ? undefined : pattern

    const fieldType = inferTypeFromPattern(pattern, hasCodeList)

    const metadata: Record<string, unknown> = {}
    if (customerName) metadata.customer_field_name = customerName
    if (category) metadata.category = category
    if (parentCategory) metadata.parent_category = parentCategory
    if (definition) metadata.definition = definition
    if (duplicable) metadata.duplicable = duplicable.toLowerCase() === 'yes' || duplicable.toLowerCase() === 'y'
    if (example) metadata.example = example
    if (synonyms) metadata.synonyms = synonyms

    fields.push({
      name: toLowerSlug(pbsName),
      label: pbsName,
      type: fieldType,
      mandatory: false,
      pattern: cleanPattern,
      terminologyName: hasCodeList ? codeList : undefined,
      terminologyValues,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    })
  }

  // Resolve identity fields: named groups match Customer Field Names, map to canonical field.name
  const identityWarnings: string[] = []
  const identityFields: string[] = []
  for (const rawName of rawIdentityNames) {
    const slug = toLowerSlug(rawName)
    // Try matching against customer_field_name metadata (case-insensitive slug comparison)
    const byCustomer = fields.find(f =>
      f.metadata?.customer_field_name && toLowerSlug(String(f.metadata.customer_field_name)) === slug
    )
    if (byCustomer) {
      identityFields.push(byCustomer.name)
    } else {
      // Fallback: try matching against field.name directly
      const byName = fields.find(f => f.name === slug)
      if (byName) {
        identityFields.push(byName.name)
      } else {
        identityWarnings.push(`Identity field "${rawName}" from Identifier Pattern not found in Customer Field Names or PBS Field Names`)
      }
    }
  }

  const suggestedName = templateMeta['Label'] || templateMeta['Name'] || dataSheetName
  return {
    suggestedName,
    suggestedValue: toSlug(suggestedName),
    description: templateMeta['Description'] || '',
    format: 'vendor',
    fields,
    identityFields,
    identityWarnings: identityWarnings.length > 0 ? identityWarnings : undefined,
    rowCount: 0,
    sheets: wb.SheetNames,
    wipFileId: fileInfo.wipFileId,
    wipFileWarning: fileInfo.wipFileWarning,
    templateMeta: Object.keys(templateMeta).length > 0 ? templateMeta : undefined,
    datasetMeta: Object.keys(datasetMeta).length > 0 ? datasetMeta : undefined,
    identifierPattern: identifierPattern || undefined,
    detectedFormat: 'vendor',
  }
}

function cellStr(rows: (string | number | null)[][], rowIdx: number | undefined, colIdx: number): string {
  if (rowIdx === undefined) return ''
  const cell = rows[rowIdx]?.[colIdx]
  return cell != null ? String(cell).trim() : ''
}
