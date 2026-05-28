// Legacy types from the old parse-template.ts — kept for backward compatibility
// during migration. Will be removed when the new save flow replaces createSaveHandler().

export type ColumnType =
  | 'string' | 'number' | 'integer' | 'boolean'
  | 'date' | 'datetime' | 'email' | 'url' | 'term'

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
