import type { Request, Response, RequestHandler } from 'express'
import { createWipClient } from '@wip/client'
import {
  downloadFile,
  deleteDocument,
  patchDocument,
  queryDocuments,
  getTemplateIdByValue,
  getTermValues,
  getValTemplateDoc,
  getWipTemplate,
  WIP_NAMESPACE,
} from './wip-api.js'
import { validateSheet, type ColumnSpec } from './validate.js'

const WIP_BASE = process.env.WIP_BASE_URL || 'https://localhost:8443'

function wip() {
  const key = process.env.WIP_API_KEY
  if (!key) throw new Error('WIP_API_KEY not set')
  return createWipClient({ baseUrl: WIP_BASE, auth: { type: 'api-key', key } })
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ValRunRow {
  document_id: string
  version: number
  created_at: string
  run_status: string
  row_count: number | null
  error_count: number | null
  warning_count: number | null
  run_at: string | null
  run_by: string | null
  source_file: string | null
  source_filename: string | null
  template: string | null
  template_name: string | null
}

function rowToValRun(row: unknown): ValRunRow {
  const r = row as Record<string, unknown>
  return {
    document_id: r['document_id'] as string,
    version: r['version'] as number,
    created_at: r['created_at'] as string,
    run_status: r['run_status'] as string,
    row_count: r['row_count'] as number | null,
    error_count: r['error_count'] as number | null,
    warning_count: r['warning_count'] as number | null,
    run_at: r['run_at'] as string | null,
    run_by: r['run_by'] as string | null,
    source_file: r['source_file'] as string | null,
    source_filename: r['source_filename'] as string | null,
    template: r['template'] as string | null,
    template_name: r['template_name'] as string | null,
  }
}

// ─── List runs ────────────────────────────────────────────────────────────────

export function listValRunsHandler(): RequestHandler {
  return async (req: Request, res: Response) => {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1)
      const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20))
      const templateFilter = (req.query.template as string) || null
      const statusFilter = (req.query.status as string) || null
      const offset = (page - 1) * pageSize

      const [data, count] = await Promise.all([
        wip().reporting.runQuery(
          `SELECT r.document_id, r.version, r.created_at, r.run_status, r.row_count,
                  r.error_count, r.warning_count, r.run_at, r.run_by,
                  r.source_file_file_id AS source_file, r.source_filename, r.template,
                  t.name AS template_name
           FROM doc_val_run r
           LEFT JOIN doc_val_template t ON t.document_id = r.template
           WHERE r.status = 'active'
             AND ($1::text IS NULL OR r.template = $1)
             AND ($2::text IS NULL OR r.run_status = $2)
           ORDER BY r.created_at DESC
           LIMIT $3 OFFSET $4`,
          [templateFilter, statusFilter, pageSize, offset]
        ),
        wip().reporting.runQuery(
          `SELECT COUNT(*)::int AS total FROM doc_val_run
           WHERE status = 'active'
             AND ($1::text IS NULL OR template = $1)
             AND ($2::text IS NULL OR run_status = $2)`,
          [templateFilter, statusFilter]
        ),
      ])

      const total = (count.rows[0] as unknown as Record<string, unknown>)['total'] as number
      res.json({
        items: data.rows.map(r => rowToValRun(r)),
        total,
        pages: Math.max(1, Math.ceil(total / pageSize)),
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('listValRuns error:', msg)
      res.status(500).json({ error: msg })
    }
  }
}

// ─── Get single run ───────────────────────────────────────────────────────────

export function getValRunHandler(): RequestHandler {
  return async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const result = await wip().reporting.runQuery(
        `SELECT r.document_id, r.version, r.created_at, r.run_status, r.row_count,
                r.error_count, r.warning_count, r.run_at, r.run_by,
                r.source_file_file_id AS source_file, r.source_filename, r.template,
                t.name AS template_name
         FROM doc_val_run r
         LEFT JOIN doc_val_template t ON t.document_id = r.template
         WHERE r.document_id = $1 AND r.status = 'active'
         LIMIT 1`,
        [id]
      )
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Run not found' })
        return
      }
      res.json(rowToValRun(result.rows[0]))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('getValRun error:', msg)
      res.status(500).json({ error: msg })
    }
  }
}

// ─── Download source file ─────────────────────────────────────────────────────

export function downloadRunFileHandler(): RequestHandler {
  return async (req: Request, res: Response) => {
    try {
      const { id } = req.params
      const result = await wip().reporting.runQuery(
        `SELECT source_file_file_id AS source_file, source_filename FROM doc_val_run
         WHERE document_id = $1 AND status = 'active' LIMIT 1`,
        [id]
      )
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Run not found' })
        return
      }
      const row = result.rows[0] as unknown as Record<string, unknown>
      const fileId = row['source_file'] as string | null
      if (!fileId) {
        res.status(404).json({ error: 'No file associated with this run' })
        return
      }
      const { buffer, contentType, filename } = await downloadFile(fileId)
      const downloadName = (row['source_filename'] as string) || filename
      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`)
      res.send(buffer)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('downloadRunFile error:', msg)
      res.status(500).json({ error: msg })
    }
  }
}

// ─── Delete (archive) run ─────────────────────────────────────────────────────

export function deleteValRunHandler(): RequestHandler {
  return async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string
      await deleteDocument(id)
      res.json({ deleted: true })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('deleteValRun error:', msg)
      const status = msg.includes('404') ? 404 : 500
      res.status(status).json({ error: msg })
    }
  }
}

// ─── Batch re-validate ────────────────────────────────────────────────────────

export function revalidateRunsHandler(): RequestHandler {
  return async (req: Request, res: Response) => {
    try {
      const { runIds } = req.body as { runIds?: string[] }
      if (!runIds || runIds.length === 0) {
        res.status(400).json({ error: 'runIds array is required' })
        return
      }
      if (runIds.length > 50) {
        res.status(400).json({ error: 'Maximum 50 runs per batch' })
        return
      }

      // Load run documents
      const runsResult = await wip().reporting.runQuery(
        `SELECT document_id, source_file_file_id AS source_file, source_filename, template
         FROM doc_val_run
         WHERE document_id = ANY($1) AND status = 'active'`,
        [runIds]
      )

      if (runsResult.rows.length === 0) {
        res.status(404).json({ error: 'No active runs found for the given IDs' })
        return
      }

      // Group by template for efficient column loading
      const byTemplate = new Map<string, Array<{ docId: string; fileId: string; filename: string }>>()
      for (const row of runsResult.rows) {
        const r = row as unknown as Record<string, unknown>
        const templateId = r['template'] as string
        const group = byTemplate.get(templateId) ?? []
        group.push({
          docId: r['document_id'] as string,
          fileId: r['source_file'] as string,
          filename: (r['source_filename'] as string) || 'unknown',
        })
        byTemplate.set(templateId, group)
      }

      // Process each template group
      const results: Array<{
        runId: string
        filename: string
        status: string
        rowCount: number
        errorCount: number
        errors: Array<{ row: number; column: string; value: string; message: string }>
      }> = []

      for (const [templateId, runs] of byTemplate) {
        // Load column specs — use WIP template if available, else legacy VAL_COLUMN
        let columns: ColumnSpec[]
        const lovSets = new Map<string, Set<string>>()

        try {
          const valTemplate = await getValTemplateDoc(templateId)
          if (valTemplate.data.wip_template_id) {
            const wipTemplate = await getWipTemplate(valTemplate.data.wip_template_id)
            columns = wipTemplate.fields.map(f => ({
              column_name: f.label,
              column_type: f.semantic_type || f.type,
              required: f.mandatory,
              lov_terminology: f.terminology_ref,
            }))
          } else {
            const colTemplateId = await getTemplateIdByValue(WIP_NAMESPACE, 'VAL_COLUMN')
            const colsResult = await queryDocuments(colTemplateId, WIP_NAMESPACE, {
              filters: [{ field: 'data.template', operator: 'eq', value: templateId }],
              pageSize: 100,
            })
            columns = colsResult.items
              .sort((a, b) => {
                const aIdx = ((a as Record<string, unknown>)['data'] as Record<string, unknown>)['column_index'] as number ?? 0
                const bIdx = ((b as Record<string, unknown>)['data'] as Record<string, unknown>)['column_index'] as number ?? 0
                return aIdx - bIdx
              })
              .map(item => {
                const d = (item as Record<string, unknown>)['data'] as Record<string, unknown>
                return {
                  column_name: d['column_name'] as string,
                  column_type: d['column_type'] as string,
                  required: (d['required'] as boolean) ?? false,
                  lov_terminology: d['lov_terminology'] as string | undefined,
                }
              })
          }
        } catch {
          // Template doc not found — fall back to legacy path
          const colTemplateId = await getTemplateIdByValue(WIP_NAMESPACE, 'VAL_COLUMN')
          const colsResult = await queryDocuments(colTemplateId, WIP_NAMESPACE, {
            filters: [{ field: 'data.template', operator: 'eq', value: templateId }],
            pageSize: 100,
          })
          columns = colsResult.items.map(item => {
            const d = (item as Record<string, unknown>)['data'] as Record<string, unknown>
            return {
              column_name: d['column_name'] as string,
              column_type: d['column_type'] as string,
              required: (d['required'] as boolean) ?? false,
              lov_terminology: d['lov_terminology'] as string | undefined,
            }
          })
        }

        await Promise.all(
          columns
            .filter(c => c.column_type === 'term' && c.lov_terminology)
            .map(async c => {
              const values = await getTermValues(c.lov_terminology!)
              lovSets.set(c.column_name, values)
            })
        )

        // Re-validate each run in this group
        for (const run of runs) {
          try {
            const { buffer } = await downloadFile(run.fileId)
            const fileResult = validateSheet(buffer, run.filename, columns, lovSets)

            await patchDocument(run.docId, {
              run_status: 'complete',
              row_count: fileResult.rowCount,
              error_count: fileResult.errorCount,
              warning_count: 0,
              run_at: new Date().toISOString(),
            }, WIP_NAMESPACE)

            results.push({
              runId: run.docId,
              filename: run.filename,
              status: 'complete',
              rowCount: fileResult.rowCount,
              errorCount: fileResult.errorCount,
              errors: fileResult.errors,
            })
          } catch (err: unknown) {
            results.push({
              runId: run.docId,
              filename: run.filename,
              status: 'failed',
              rowCount: 0,
              errorCount: 0,
              errors: [{ row: 0, column: '', value: '', message: err instanceof Error ? err.message : 'Re-validation failed' }],
            })
          }
        }
      }

      res.json({ results })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('revalidateRuns error:', msg)
      res.status(500).json({ error: msg })
    }
  }
}
