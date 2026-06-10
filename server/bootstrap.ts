/**
 * Idempotent bootstrap for the wip-val namespace, callable from the server
 * (GET/POST /api/bootstrap/*) or the CLI wrapper (data-model/bootstrap.ts).
 *
 * Seeds live in data-model/*.json. Safe to re-run: creates only missing
 * entities, updates templates when fields change.
 */

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import type { FieldDefinition } from '@wip/client'
import { wipClient, WIP_NAMESPACE } from './wip-api.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const SEED_DIR = join(__dir, '..', 'data-model')

interface TermSeed {
  value: string
  label: string
  description: string
  namespace: string
  terms: { value: string; label: string; description: string; sort_order: number }[]
}

interface TemplateSeed {
  value: string
  label: string
  description: string
  namespace: string
  identity_fields?: string[]
  fields: { name: string; label: string; type: string; mandatory?: boolean; [k: string]: unknown }[]
}

function loadSeeds() {
  const ns = JSON.parse(readFileSync(join(SEED_DIR, 'namespace.json'), 'utf8'))
  const terminologies: TermSeed[] = JSON.parse(readFileSync(join(SEED_DIR, 'terminologies.json'), 'utf8'))
  const templates: TemplateSeed[] = JSON.parse(readFileSync(join(SEED_DIR, 'templates.json'), 'utf8'))
  return { ns, terminologies, templates }
}

export type BootstrapStatus = 'ready' | 'needs_bootstrap' | 'wip_unreachable'

export interface BootstrapProgress {
  step: string
  detail: string
}

// Namespace exists AND has at least one template → ready. A bare namespace
// (or none) needs bootstrap; only a failure to reach WIP at all is unreachable.
export async function checkBootstrapStatus(): Promise<{ status: BootstrapStatus; detail?: string }> {
  let namespaces: { prefix: string }[]
  try {
    namespaces = await wipClient().registry.listNamespaces()
  } catch (err) {
    return { status: 'wip_unreachable', detail: (err as Error).message }
  }
  if (namespaces.some(n => n.prefix === WIP_NAMESPACE)) {
    try {
      const templates = await wipClient().templates.listTemplates({ namespace: WIP_NAMESPACE, page_size: 1 })
      if (templates.total > 0) return { status: 'ready' }
    } catch {
      // namespace exists but templates can't be listed — treat as needs bootstrap
    }
  }
  return { status: 'needs_bootstrap' }
}

export async function runBootstrap(onProgress: (e: BootstrapProgress) => void): Promise<void> {
  const { ns, terminologies, templates } = loadSeeds()
  const client = wipClient()

  onProgress({ step: 'namespace', detail: `upserting ${ns.prefix}` })
  await client.registry.upsertNamespace(ns.prefix, {
    description: ns.description,
    isolation_mode: ns.isolation_mode,
    deletion_mode: ns.deletion_mode,
  })

  for (const t of terminologies) {
    let terminologyId: string
    const list = await client.defStore.listTerminologies({ namespace: t.namespace, value: t.value, page_size: 10 })
    const existing = list.items.find(x => x.value === t.value)

    if (existing) {
      terminologyId = existing.terminology_id
      onProgress({ step: 'terminology', detail: `${t.value} exists` })
    } else {
      const created = await client.defStore.createTerminology({
        value: t.value,
        label: t.label,
        description: t.description,
        namespace: t.namespace,
      })
      terminologyId = created.id!
      onProgress({ step: 'terminology', detail: `${t.value} created` })
    }

    const existingTerms = await client.defStore.listTerms(terminologyId, { page_size: 200 })
    const existingValues = new Set(existingTerms.items.map(x => x.value))
    const newTerms = t.terms.filter(term => !existingValues.has(term.value))

    if (newTerms.length > 0) {
      await client.defStore.createTerms(terminologyId, newTerms, { namespace: t.namespace })
      onProgress({ step: 'terms', detail: `${t.value}: ${newTerms.length} term(s) created` })
    }
  }

  for (const tpl of templates) {
    const list = await client.templates.listTemplates({ namespace: tpl.namespace, page_size: 100 })
    const existing = list.items.find(t => t.value === tpl.value)

    if (existing) {
      const localFieldNames = tpl.fields.map(f => f.name).sort().join(',')
      const remoteFieldNames = (existing.fields as { name: string }[]).map(f => f.name).sort().join(',')

      if (localFieldNames !== remoteFieldNames) {
        await client.templates.updateTemplate(existing.template_id, {
          fields: tpl.fields as unknown as FieldDefinition[],
          identity_fields: tpl.identity_fields,
          label: tpl.label,
          description: tpl.description,
        })
        onProgress({ step: 'template', detail: `${tpl.value} updated (v${existing.version} → v${existing.version + 1})` })
      } else {
        onProgress({ step: 'template', detail: `${tpl.value} exists v${existing.version}` })
      }
    } else {
      await client.templates.createTemplate({
        value: tpl.value,
        label: tpl.label,
        description: tpl.description,
        namespace: tpl.namespace,
        identity_fields: tpl.identity_fields,
        fields: tpl.fields as unknown as FieldDefinition[],
      })
      onProgress({ step: 'template', detail: `${tpl.value} created` })
    }
  }

  // "Latest active" template resolution has a 5s cache TTL (PoNIF #6) —
  // wait it out so the app doesn't validate against a stale cache entry.
  onProgress({ step: 'cache', detail: 'waiting for template cache refresh' })
  await new Promise(resolve => setTimeout(resolve, 6000))

  onProgress({ step: 'done', detail: 'bootstrap complete' })
}
