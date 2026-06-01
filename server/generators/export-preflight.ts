import type { WipTemplateField, WipTemplateRule } from '../wip-api.js'

// ─── Export feature-compatibility classifier ─────────────────────────────────
// A WIP template is richer than vendor/c02 can express. This classifies a
// template's features into ok / lossy / blocking and feeds the force policy:
//   - blocking present  → refuse unless force; forced ⇒ skipped + warned
//   - lossy             → always proceed + warn
//   - usage=relationship→ hard refuse (even forced)
// See report-excel-export-from-template.md (fireside).

export interface ExportNote {
  field?: string
  feature: string
  severity: 'lossy' | 'blocking'
  action: 'degraded' | 'skipped'
  detail: string
}

export interface PreflightResult {
  hardRefused: boolean
  hardRefuseReason?: string
  blocking: ExportNote[]
  lossy: ExportNote[]
  skipFields: string[] // field.name to drop from the sheet when force=true
}

export interface TemplateForExport {
  usage?: string
  extends?: string | null
  rules?: WipTemplateRule[]
  fields: WipTemplateField[] // MUST be resolved (own + inherited)
}

const LOSSY_TYPE_TO: Record<string, string> = { number: 'string', datetime: 'string' }

/** Vendor-format compatibility classifier. (c02 will get its own — it can carry
 *  mandatory via cell styling and infers email/url/number from data, but loses
 *  identity + metadata; different lossy/blocking sets.) */
export function preflightVendor(tpl: TemplateForExport): PreflightResult {
  const blocking: ExportNote[] = []
  const lossy: ExportNote[] = []
  const skipFields: string[] = []

  if (tpl.usage === 'relationship') {
    return {
      hardRefused: true,
      hardRefuseReason:
        'Edge type (usage=relationship) is a relationship, not a record schema — not exportable to a spreadsheet.',
      blocking, lossy, skipFields,
    }
  }

  if (tpl.extends) {
    lossy.push({
      feature: 'inheritance', severity: 'lossy', action: 'degraded',
      detail: `Template extends "${tpl.extends}". Inherited fields are flattened into the sheet; the parent link is not preserved on re-import.`,
    })
  }

  for (const r of tpl.rules ?? []) {
    blocking.push({
      feature: `rule:${r.type}`, severity: 'blocking', action: 'skipped',
      detail: `Cross-field rule "${r.type}"${r.description ? ` — ${r.description}` : ''} has no vendor representation; dropped.`,
    })
  }

  for (const f of tpl.fields) {
    // References: a term reference behaves like a term/LOV (OK); all others skip.
    if (f.type === 'reference') {
      if (f.reference_type === 'term') {
        // handled as a term by the generator — OK
      } else {
        blocking.push({
          field: f.name, feature: `reference:${f.reference_type ?? 'document'}`, severity: 'blocking', action: 'skipped',
          detail: `Reference field "${f.label}" (${f.reference_type ?? 'document'}) has no spreadsheet form; column skipped.`,
        })
        skipFields.push(f.name)
      }
      continue
    }
    if (f.type === 'array' || f.type === 'object' || f.type === 'file') {
      blocking.push({
        field: f.name, feature: `type:${f.type}`, severity: 'blocking', action: 'skipped',
        detail: `Field "${f.label}" of type ${f.type} cannot live in a cell; column skipped.`,
      })
      skipFields.push(f.name)
      continue
    }

    if (LOSSY_TYPE_TO[f.type]) {
      lossy.push({
        field: f.name, feature: `type:${f.type}`, severity: 'lossy', action: 'degraded',
        detail: `Field "${f.label}" of type ${f.type} has no vendor type; exported as ${LOSSY_TYPE_TO[f.type]}.`,
      })
    }
    if (f.mandatory) {
      lossy.push({
        field: f.name, feature: 'mandatory', severity: 'lossy', action: 'degraded',
        detail: `"${f.label}" is mandatory; vendor has no mandatory marker, so it is not preserved.`,
      })
    }
    if (f.semantic_type) {
      lossy.push({
        field: f.name, feature: `semantic_type:${f.semantic_type}`, severity: 'lossy', action: 'degraded',
        detail: `Semantic type ${f.semantic_type} on "${f.label}" is not preserved in vendor.`,
      })
    }
    const v = f.validation
    if (v) {
      // Patterns ARE preserved (written to the vendor Pattern cell) for non-term
      // fields. Only a term field's pattern is dropped — the Code List/LOV defines
      // its validity, so the Pattern slot is unused.
      if (v.pattern && f.terminology_ref) {
        lossy.push({
          field: f.name, feature: 'validation.pattern', severity: 'lossy', action: 'degraded',
          detail: `Custom pattern on "${f.label}" is dropped — it is a controlled (term) field; the Code List/LOV defines validity.`,
        })
      }
      if (v.minimum != null || v.maximum != null) {
        lossy.push({ field: f.name, feature: 'validation.range', severity: 'lossy', action: 'degraded',
          detail: `Numeric bounds on "${f.label}" are not representable in vendor.` })
      }
      if (v.min_length != null || v.max_length != null) {
        lossy.push({ field: f.name, feature: 'validation.length', severity: 'lossy', action: 'degraded',
          detail: `Length bounds on "${f.label}" are not representable in vendor.` })
      }
    }
    if (f.default_value != null) {
      lossy.push({ field: f.name, feature: 'default_value', severity: 'lossy', action: 'degraded',
        detail: `Default value on "${f.label}" is not representable in vendor.` })
    }
  }

  return { hardRefused: false, blocking, lossy, skipFields }
}

/** Apply the force policy. */
export function exportDecision(pf: PreflightResult, force: boolean): { allowed: boolean; reason?: string } {
  if (pf.hardRefused) return { allowed: false, reason: pf.hardRefuseReason }
  if (pf.blocking.length && !force) {
    return { allowed: false, reason: `${pf.blocking.length} feature(s) cannot be exported to vendor; re-run with force=true to skip them.` }
  }
  return { allowed: true }
}
