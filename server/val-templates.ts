import type { Request, Response, RequestHandler } from 'express'
import {
  queryValTemplates,
  getValTemplateDoc,
  queryColumnsForTemplate,
  getWipTemplate,
  patchDocument,
  deleteDocument,
  downloadFile,
  WIP_NAMESPACE,
} from './wip-api.js'
import { createWipClient } from '@wip/client'

const WIP_BASE = process.env.WIP_BASE_URL || 'https://localhost:8443'

function wip() {
  const key = process.env.WIP_API_KEY
  if (!key) throw new Error('WIP_API_KEY not set')
  return createWipClient({ baseUrl: WIP_BASE, auth: { type: 'api-key', key } })
}

// ─── GET /api/val-templates?search=&page=1&pageSize=20 ────────────────────────

export function listValTemplatesHandler(): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const search = (req.query.search as string | undefined ?? '').trim()
      const page = Math.max(1, parseInt(req.query.page as string || '1', 10))
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string || '20', 10)))

      const data = await queryValTemplates(search, page, pageSize)
      res.json(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  }
}

// ─── GET /api/val-templates/:id ───────────────────────────────────────────────

export function getValTemplateHandler(): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string }
    try {
      const templateDoc = await getValTemplateDoc(id)

      // New path: load fields from WIP template
      if (templateDoc.data.wip_template_id) {
        const wipTemplate = await getWipTemplate(templateDoc.data.wip_template_id)
        res.json({
          template: templateDoc,
          fields: wipTemplate.fields,
          identityFields: wipTemplate.identity_fields,
          wipTemplateVersion: wipTemplate.version,
        })
        return
      }

      // Legacy path: load columns from VAL_COLUMN documents
      const columns = await queryColumnsForTemplate(id)
      res.json({ template: templateDoc, columns })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message.includes('404') ? 404 : 500
      res.status(status).json({ error: message })
    }
  }
}

// ─── DELETE /api/val-templates/:id ───────────────────────────────────────────

export function deleteValTemplateHandler(): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string }
    try {
      const templateDoc = await getValTemplateDoc(id)

      if (templateDoc.data.wip_template_id) {
        // New path: soft-delete linked WIP template + VAL_TEMPLATE doc
        const client = wip()
        await Promise.all([
          client.templates.deleteTemplate(templateDoc.data.wip_template_id),
          deleteDocument(id),
        ])
      } else {
        // Legacy path: delete VAL_COLUMN docs + VAL_TEMPLATE doc
        const columns = await queryColumnsForTemplate(id)
        await Promise.all([
          ...columns.map(col => deleteDocument(col.document_id)),
          deleteDocument(id),
        ])
      }

      res.json({ deleted: true })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message.includes('404') ? 404 : 500
      res.status(status).json({ error: message })
    }
  }
}

// ─── GET /api/val-templates/:id/download ─────────────────────────────────────

export function downloadTemplateFileHandler(): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string }
    try {
      const templateDoc = await getValTemplateDoc(id)
      const fileId = templateDoc.data.source_file
      if (!fileId) {
        res.status(404).json({ error: 'No source file attached to this template' })
        return
      }
      const { buffer, contentType, filename } = await downloadFile(fileId)
      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(buffer)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message.includes('404') ? 404 : 500
      res.status(status).json({ error: message })
    }
  }
}

// ─── PATCH /api/val-templates/:id/fields ─────────────────────────────────────
// Updates fields on the linked WIP template (creates new version)

interface FieldPatch {
  name: string
  type?: string
  label?: string
  mandatory?: boolean
}

export function patchValTemplateFieldsHandler(): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string }
    const updates = req.body as FieldPatch[]
    if (!Array.isArray(updates) || updates.length === 0) {
      res.status(400).json({ error: 'Body must be a non-empty array of field patches' })
      return
    }

    try {
      const templateDoc = await getValTemplateDoc(id)

      if (templateDoc.data.wip_template_id) {
        // New path: update WIP template fields
        const wipTemplate = await getWipTemplate(templateDoc.data.wip_template_id)
        const patchMap = new Map(updates.map(u => [u.name, u]))

        const updatedFields = wipTemplate.fields.map(field => {
          const patch = patchMap.get(field.name)
          if (!patch) return field
          return {
            ...field,
            ...(patch.type !== undefined ? { type: patch.type } : {}),
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.mandatory !== undefined ? { mandatory: patch.mandatory } : {}),
          }
        })

        const client = wip()
        await client.templates.updateTemplate(templateDoc.data.wip_template_id, {
          fields: updatedFields as never[],
        })
        res.json({ updated: updates.length })
      } else {
        // Legacy path: patch VAL_COLUMN documents
        const legacyUpdates = updates.map(u => ({
          document_id: u.name, // caller passes document_id as name for legacy
          column_type: u.type,
          display_name: u.label,
        }))
        const results = await Promise.all(
          legacyUpdates.map(u => {
            const patch: Record<string, unknown> = {}
            if (u.column_type !== undefined) patch.column_type = u.column_type
            if (u.display_name !== undefined) patch.display_name = u.display_name
            return patchDocument(u.document_id, patch, WIP_NAMESPACE)
          })
        )
        res.json({ updated: results.length })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  }
}

// ─── Legacy PATCH /api/val-templates/:id/columns (backward compat) ──────────

interface ColumnPatch {
  document_id: string
  column_type?: string
  display_name?: string
}

export function patchValTemplateColumnsHandler(): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const updates = req.body as ColumnPatch[]
    if (!Array.isArray(updates) || updates.length === 0) {
      res.status(400).json({ error: 'Body must be a non-empty array of column patches' })
      return
    }

    try {
      const results = await Promise.all(
        updates.map(u => {
          const patch: Record<string, unknown> = {}
          if (u.column_type !== undefined) patch.column_type = u.column_type
          if (u.display_name !== undefined) patch.display_name = u.display_name
          return patchDocument(u.document_id, patch, WIP_NAMESPACE)
        })
      )
      res.json({ updated: results.length })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      res.status(500).json({ error: message })
    }
  }
}
