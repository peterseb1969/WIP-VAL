import multer from 'multer'
import * as XLSX from 'xlsx'
import type { Request, Response, RequestHandler } from 'express'
import { uploadFileToWip, WIP_NAMESPACE } from './wip-api.js'
import { detectFormat } from './parsers/format-detect.js'
import { parseC02 } from './parsers/c02-parser.js'
import { parseVendor } from './parsers/vendor-parser.js'
import type { ParsedTemplate } from './parsed-template.js'

// Re-export for backward compatibility during transition
export type { ParsedTemplate, ParsedField, SpreadsheetFormat } from './parsed-template.js'

// ─── Parse handler (dispatcher) ──────────────────────────────────────────────

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

      if (!wb.SheetNames.length) {
        res.status(422).json({ error: 'Spreadsheet has no sheets' })
        return
      }

      // Upload source file to WIP (non-fatal)
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

      const fileInfo = { wipFileId, wipFileWarning }
      const format = detectFormat(wb.SheetNames)

      let result: ParsedTemplate
      if (format === 'vendor') {
        result = parseVendor(wb, fileInfo)
      } else {
        result = parseC02(wb, fileInfo)
      }

      // Override suggested name with filename if the parser gave a generic one
      if (!result.suggestedName || result.suggestedName === wb.SheetNames[0]) {
        result.suggestedName = req.file.originalname.replace(/\.[^.]+$/, '')
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

// ─── Save handler (legacy — will be replaced by save-template.ts) ────────────

import {
  getTemplateIdByValue,
  createDocument,
  getOrCreateTerminology,
  upsertTerms,
  lovTerminologyValue,
} from './wip-api.js'
import type { ApprovedColumn, SaveRequest } from './legacy-types.js'

export type { ApprovedColumn, SaveRequest }

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

      const [valTemplateId, valColumnId] = await Promise.all([
        getTemplateIdByValue(WIP_NAMESPACE, 'VAL_TEMPLATE'),
        getTemplateIdByValue(WIP_NAMESPACE, 'VAL_COLUMN'),
      ])

      const templateData: Record<string, unknown> = {
        name: templateName,
        description: templateDescription || '',
        column_count: columns.length,
        created_by: createdBy,
      }
      if (wipFileId) templateData.source_file = wipFileId

      const templateDoc = await createDocument(valTemplateId, WIP_NAMESPACE, templateData, createdBy)

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
          await upsertTerms(term.terminology_id, WIP_NAMESPACE, col.lovValues ?? [])
          lovTermIds[col.columnIndex] = term.terminology_id
          terminologiesCreated.push(termValue)
        })
      )

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
