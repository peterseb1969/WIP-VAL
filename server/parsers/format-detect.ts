import type { SpreadsheetFormat } from '../parsed-template.js'

export function detectFormat(sheetNames: string[]): SpreadsheetFormat | null {
  const hasLoV = sheetNames.some(s => s.toLowerCase().includes('lov'))
  const hasMeta = sheetNames.some(s => s.toLowerCase().includes('template meta information'))
  if (hasLoV && hasMeta) return 'vendor'

  const hasValidationSheet = sheetNames.some(s => s.toLowerCase().includes('validation sheet'))
  if (hasValidationSheet) return 'c02'

  return null
}
