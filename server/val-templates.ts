import type { Request, Response, RequestHandler } from 'express'
import {
  getTemplateIdByValue,
  queryDocuments,
  getDocument,
  patchDocument,
  deleteDocument,
  getFileDownloadUrl,
  WIP_NAMESPACE,
} from './wip-api.js'

// ─── GET /api/val-templates?search=&page=1&pageSize=20 ────────────────────────

export function listValTemplatesHandler(): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const templateId = await getTemplateIdByValue(WIP_NAMESPACE, 'VAL_TEMPLATE')
      const search = (req.query.search as string | undefined ?? '').trim()
      const page = Math.max(1, parseInt(req.query.page as string || '1', 10))
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string || '20', 10)))

      const filters = search
        ? [{ field: 'data.name', operator: 'regex', value: `(?i)${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` }]
        : undefined

      const data = await queryDocuments(templateId, WIP_NAMESPACE, { filters, page, pageSize })
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
      const [templateDoc, colTemplateId] = await Promise.all([
        getDocument(id),
        getTemplateIdByValue(WIP_NAMESPACE, 'VAL_COLUMN'),
      ])

      const colsResult = await queryDocuments(colTemplateId, WIP_NAMESPACE, {
        filters: [{ field: 'data.template', operator: 'eq', value: id }],
        pageSize: 100,
      })

      const columns = [...colsResult.items].sort((a, b) => {
        const aData = a.data as Record<string, unknown>
        const bData = b.data as Record<string, unknown>
        return ((aData.column_index as number) ?? 0) - ((bData.column_index as number) ?? 0)
      })

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
      const colTemplateId = await getTemplateIdByValue(WIP_NAMESPACE, 'VAL_COLUMN')
      const colsResult = await queryDocuments(colTemplateId, WIP_NAMESPACE, {
        filters: [{ field: 'data.template', operator: 'eq', value: id }],
        pageSize: 100,
      })

      // Delete all column documents then the template document in parallel
      await Promise.all([
        ...colsResult.items.map(item =>
          deleteDocument((item as Record<string, unknown>)['document_id'] as string)
        ),
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
      const templateDoc = await getDocument(id)
      const data = (templateDoc as Record<string, unknown>)['data'] as Record<string, unknown>
      const fileId = data['source_file'] as string | undefined
      if (!fileId) {
        res.status(404).json({ error: 'No source file attached to this template' })
        return
      }
      const downloadUrl = await getFileDownloadUrl(fileId)
      res.redirect(downloadUrl)
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
