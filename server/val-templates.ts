import type { Request, Response, RequestHandler } from 'express'
import {
  queryValTemplates,
  getValTemplateDoc,
  queryColumnsForTemplate,
  patchDocument,
  deleteDocument,
  downloadFile,
  WIP_NAMESPACE,
} from './wip-api.js'

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
      const [templateDoc, columns] = await Promise.all([
        getValTemplateDoc(id),
        queryColumnsForTemplate(id),
      ])

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
      const columns = await queryColumnsForTemplate(id)

      // Delete all column documents then the template document in parallel
      await Promise.all([
        ...columns.map(col => deleteDocument(col.document_id)),
        deleteDocument(id),
      ])

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

// ─── PATCH /api/val-templates/:id/columns ────────────────────────────────────
// Body: Array of { document_id, column_type?, display_name? }

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
