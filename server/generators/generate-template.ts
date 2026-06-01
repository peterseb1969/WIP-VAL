import * as XLSX from 'xlsx'
import { getWipTemplateResolved, getTermValues, queryDocuments, WIP_NAMESPACE } from '../wip-api.js'
import { generateVendorWorkbook } from './generate-vendor.js'
import { preflightVendor, exportDecision, type ExportNote } from './export-preflight.js'

// ─── Export dispatcher ───────────────────────────────────────────────────────
// Input is a raw WIP template (no VAL_TEMPLATE wrapper). Reads the resolved
// template, runs the compatibility preflight + force policy, then serializes to
// the chosen external format. Vendor is implemented; c02 is pending.

export type ExportFormat = 'vendor' | 'c02'
export type ExportMode = 'template' | 'data'

export interface ExportRequest {
  templateId: string
  format: ExportFormat
  mode: ExportMode
  force: boolean
}

export interface ExportResult {
  buffer: Buffer
  filename: string
  warnings: ExportNote[]
}

export class ExportRefused extends Error {
  constructor(
    message: string,
    public hardRefused: boolean,
    public blocking: ExportNote[],
    public lossy: ExportNote[],
  ) {
    super(message)
    this.name = 'ExportRefused'
  }
}

export async function exportTemplate(req: ExportRequest): Promise<ExportResult> {
  if (req.format !== 'vendor') {
    throw new ExportRefused(`Export format "${req.format}" is not implemented yet (vendor only).`, false, [], [])
  }

  const tpl = await getWipTemplateResolved(req.templateId)

  const pf = preflightVendor({ usage: tpl.usage, extends: tpl.extends, rules: tpl.rules, fields: tpl.fields })
  const decision = exportDecision(pf, req.force)
  if (!decision.allowed) {
    throw new ExportRefused(decision.reason ?? 'Export refused.', pf.hardRefused, pf.blocking, pf.lossy)
  }

  const skip = new Set(pf.skipFields)
  const fields = tpl.fields.filter(f => !skip.has(f.name))

  // Resolve LOV values for term fields.
  const lov = new Map<string, string[]>()
  await Promise.all(
    fields.filter(f => f.type === 'term' && f.terminology_ref).map(async f => {
      const vals = await getTermValues(f.terminology_ref!)
      lov.set(f.name, [...vals])
    })
  )

  // Data mode: pull existing documents as rows (keyed by field.name).
  let dataRows: Record<string, unknown>[] | undefined
  if (req.mode === 'data') {
    const { items } = await queryDocuments(tpl.template_id, WIP_NAMESPACE, { pageSize: 1000 })
    dataRows = items.map(it => ((it as Record<string, unknown>)['data'] as Record<string, unknown>) ?? {})
  }

  const wb = generateVendorWorkbook(
    {
      label: tpl.label,
      description: tpl.description,
      fields,
      identityFields: tpl.identity_fields.filter(n => !skip.has(n)),
      lov,
    },
    { includeData: req.mode === 'data', dataRows }
  )

  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
  return { buffer, filename: `${tpl.value || 'template'}.xlsx`, warnings: [...pf.blocking, ...pf.lossy] }
}
