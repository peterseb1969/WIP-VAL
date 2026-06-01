import * as XLSX from 'xlsx'
import type { WipTemplateField } from '../wip-api.js'

// ─── Vendor generator: WIP template (native) → vendor external workbook ──────
// Inverse of server/parsers/vendor-parser.ts. Codec-paired with it: the layout
// (row labels, sheet names) MUST stay in sync with the parser, which the
// round-trip test enforces. Input is the template's intrinsic model only —
// never a prior import artifact.

export interface VendorGenerateInput {
  label: string
  description: string
  fields: WipTemplateField[]
  identityFields: string[]
  /** field.name → resolved term values, for term fields (from getTermValues). */
  lov: Map<string, string[]>
  /** Optional enrichment, present only when imported from vendor; else synthesized. */
  templateMeta?: Record<string, string>
  datasetMeta?: Record<string, string>
}

export interface VendorGenerateOptions {
  includeData?: boolean
  /** Each record keyed by field.name. */
  dataRows?: Record<string, unknown>[]
}

// Emit a Pattern the parser will re-infer back to the same WIP type. Vendor's
// type vocabulary is limited (string/integer/boolean/date/term); number,
// datetime, email, url have no distinct vendor form and round-trip to the
// nearest type (documented, expected — see the fireside).
function typeToPattern(field: WipTemplateField): string {
  if (field.terminology_ref) return '' // term: Code List carries it, Pattern unused
  // Prefer the field's real pattern: it round-trips the pattern AND the type
  // (for vendor-imported fields the type was inferred from this very pattern).
  // Synthesize a type-pattern only when the field has no explicit one.
  if (field.validation?.pattern) return field.validation.pattern
  switch (field.type) {
    case 'integer': return '^-?\\d+$'
    case 'date':    return '^\\d{4}-\\d{2}-\\d{2}$'
    case 'boolean': return '^(Y|N)$'
    default:        return ''
  }
}

// identity_fields → Identifier Pattern with named groups. The parser extracts
// the (?<name>) group names and maps them back to fields by name, so the group
// names must equal field.name. The regex body is irrelevant to round-trip.
function buildIdentifierPattern(identityFields: string[]): string {
  return identityFields.map(n => `(?<${n}>.+)`).join('_')
}

export function generateVendorWorkbook(
  input: VendorGenerateInput,
  opts: VendorGenerateOptions = {}
): XLSX.WorkBook {
  const wb = XLSX.utils.book_new()
  const { fields } = input
  const codeListName = (f: WipTemplateField) => f.label // also the LoV column header

  // Sheet 0 — spec sheet (transposed: row labels in col A, fields in cols B+).
  const rowDefs: [string, (f: WipTemplateField) => string][] = [
    ['PBS Field Name',       f => f.label],
    ['Customer Field Name',  f => String(f.metadata?.customer_field_name ?? '')],
    ['Pattern',              f => typeToPattern(f) || '{}'],
    ['Code List',            f => (f.terminology_ref ? codeListName(f) : '')],
    ['Field Category',       f => String(f.metadata?.category ?? '')],
    ['Parent Category',      f => String(f.metadata?.parent_category ?? '')],
    ['Definition',           f => String(f.metadata?.definition ?? '')],
    ['Ability to Duplicate', f => (f.metadata?.duplicable ? 'Yes' : '')],
    ['Example',              f => String(f.metadata?.example ?? '')],
    ['Synonyms',             f => String(f.metadata?.synonyms ?? '')],
  ]
  const specAoa = rowDefs.map(([label, fn]) => [label, ...fields.map(fn)])
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(specAoa), 'Fields')

  // LoV sheet — one column per term field's code list (header = code-list name).
  const termFields = fields.filter(f => f.terminology_ref)
  const lovHeaders = termFields.map(codeListName)
  const lovCols = termFields.map(f => input.lov.get(f.name) ?? [])
  const maxLen = lovCols.reduce((m, c) => Math.max(m, c.length), 0)
  const lovAoa: string[][] = [lovHeaders]
  for (let r = 0; r < maxLen; r++) lovAoa.push(lovCols.map(c => c[r] ?? ''))
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(lovAoa), 'LoV')

  // Template Meta Information — column-per-attribute (row0 keys, row1 values).
  const tMeta: Record<string, string> = {
    Label: input.label,
    Name: input.label,
    Description: input.description,
    ...(input.templateMeta ?? {}),
  }
  const tKeys = Object.keys(tMeta)
  XLSX.utils.book_append_sheet(
    wb, XLSX.utils.aoa_to_sheet([tKeys, tKeys.map(k => tMeta[k])]), 'Template Meta Information'
  )

  // Dataset Meta Information — carries the Identifier Pattern.
  const dMeta: Record<string, string> = { ...(input.datasetMeta ?? {}) }
  if (input.identityFields.length) {
    dMeta['Identifier Pattern'] = buildIdentifierPattern(input.identityFields)
  }
  const dKeys = Object.keys(dMeta)
  if (dKeys.length) {
    XLSX.utils.book_append_sheet(
      wb, XLSX.utils.aoa_to_sheet([dKeys, dKeys.map(k => dMeta[k])]), 'Dataset Meta Information'
    )
  }

  // Optional appended data sheet (parser ignores it; safe for round-trip).
  if (opts.includeData) {
    const dataAoa: unknown[][] = [fields.map(f => f.label)]
    for (const row of opts.dataRows ?? []) dataAoa.push(fields.map(f => row[f.name] ?? ''))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dataAoa), 'Data Records')
  }

  return wb
}
