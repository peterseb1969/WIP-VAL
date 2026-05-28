export type WipFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'term'
export type SemanticType = 'email' | 'url'
export type SpreadsheetFormat = 'c02' | 'vendor'

export interface ParsedField {
  name: string
  label: string
  type: WipFieldType
  mandatory: boolean
  semanticType?: SemanticType
  pattern?: string
  minimum?: number
  maximum?: number
  terminologyValues?: string[]
  terminologyName?: string
  metadata?: Record<string, unknown>
}

export interface ParsedTemplate {
  suggestedName: string
  suggestedValue: string
  description: string
  format: SpreadsheetFormat
  fields: ParsedField[]
  identityFields: string[]
  rowCount: number
  sheets: string[]
  wipFileId?: string
  wipFileWarning?: string
  templateMeta?: Record<string, string>
  datasetMeta?: Record<string, string>
  identifierPattern?: string
  identityWarnings?: string[]
  detectedFormat: SpreadsheetFormat | null
}
