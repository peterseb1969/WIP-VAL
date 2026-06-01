import type { Request, Response, RequestHandler } from 'express'
import { exportTemplate, ExportRefused, type ExportFormat, type ExportMode } from './generators/generate-template.js'
import { getWipTemplateResolved } from './wip-api.js'
import { preflightVendor } from './generators/export-preflight.js'

// GET /api/templates/:id/export?format=vendor&mode=template|data&force=true
// :id is a raw WIP template_id (no VAL_TEMPLATE wrapper required).
export function createExportTemplateHandler(): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string }
    const format = ((req.query.format as string) || 'vendor') as ExportFormat
    const mode = ((req.query.mode as string) || 'template') as ExportMode
    const force = req.query.force === 'true'

    try {
      const result = await exportTemplate({ templateId: id, format, mode, force })
      if (result.warnings.length) {
        res.setHeader('X-Export-Warnings', JSON.stringify(
          result.warnings.map(w => ({ feature: w.feature, field: w.field, severity: w.severity, action: w.action }))
        ))
      }
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
      res.send(result.buffer)
    } catch (err: unknown) {
      if (err instanceof ExportRefused) {
        res.status(422).json({
          error: err.message, hardRefused: err.hardRefused, blocking: err.blocking, lossy: err.lossy,
        })
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      res.status(msg.includes('not found') ? 404 : 500).json({ error: msg })
    }
  }
}

// GET /api/templates/:id/export/preflight — classify without generating.
export function createExportPreflightHandler(): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params as { id: string }
    try {
      const tpl = await getWipTemplateResolved(id)
      const pf = preflightVendor({ usage: tpl.usage, extends: tpl.extends, rules: tpl.rules, fields: tpl.fields })
      res.json({
        template: { value: tpl.value, label: tpl.label, fieldCount: tpl.fields.length },
        hardRefused: pf.hardRefused,
        hardRefuseReason: pf.hardRefuseReason,
        blocking: pf.blocking,
        lossy: pf.lossy,
        skipFields: pf.skipFields,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      res.status(msg.includes('not found') ? 404 : 500).json({ error: msg })
    }
  }
}
