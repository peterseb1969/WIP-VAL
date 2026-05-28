/**
 * Idempotent bootstrap for the wip-val namespace.
 *
 * Usage: npx tsx data-model/bootstrap.ts
 *
 * Safe to re-run: creates only missing entities, updates templates when fields change.
 */

import 'dotenv/config'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createWipClient } from '@wip/client'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const __dir = dirname(fileURLToPath(import.meta.url))

const WIP_BASE = process.env.WIP_BASE_URL || 'https://localhost:8443'
const WIP_API_KEY = process.env.WIP_API_KEY
if (!WIP_API_KEY) throw new Error('WIP_API_KEY not set — check .env')

const client = createWipClient({ baseUrl: WIP_BASE, auth: { type: 'api-key', key: WIP_API_KEY } })

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

const ns = JSON.parse(readFileSync(join(__dir, 'namespace.json'), 'utf8'))
const terminologies: TermSeed[] = JSON.parse(readFileSync(join(__dir, 'terminologies.json'), 'utf8'))
const templates: TemplateSeed[] = JSON.parse(readFileSync(join(__dir, 'templates.json'), 'utf8'))

async function bootstrapNamespace() {
  console.log(`→ namespace ${ns.prefix}`)
  await client.registry.upsertNamespace(ns.prefix, {
    description: ns.description,
    isolation_mode: ns.isolation_mode,
    deletion_mode: ns.deletion_mode,
  })
  console.log(`  ✓ upserted`)
}

async function bootstrapTerminologies() {
  for (const t of terminologies) {
    console.log(`→ terminology ${t.value}`)

    let terminologyId: string
    const list = await client.defStore.listTerminologies({ namespace: t.namespace, value: t.value, page_size: 10 })
    const existing = list.items.find(x => x.value === t.value)

    if (existing) {
      terminologyId = existing.terminology_id
      console.log(`  ✓ exists (${terminologyId})`)
    } else {
      const created = await client.defStore.createTerminology({
        value: t.value,
        label: t.label,
        description: t.description,
        namespace: t.namespace,
      })
      terminologyId = created.id!
      console.log(`  ✓ created (${terminologyId})`)
    }

    const existingTerms = await client.defStore.listTerms(terminologyId, { page_size: 200 })
    const existingValues = new Set(existingTerms.items.map(x => x.value))
    const newTerms = t.terms.filter(term => !existingValues.has(term.value))

    if (newTerms.length > 0) {
      await client.defStore.createTerms(terminologyId, newTerms, { namespace: t.namespace })
      console.log(`  + ${newTerms.length} term(s) created`)
    } else {
      console.log(`  - all ${t.terms.length} term(s) already exist`)
    }
  }
}

async function bootstrapTemplates() {
  for (const tpl of templates) {
    console.log(`→ template ${tpl.value}`)

    const list = await client.templates.listTemplates({ namespace: tpl.namespace, page_size: 100 })
    const existing = list.items.find(t => t.value === tpl.value)

    if (existing) {
      const localFieldNames = tpl.fields.map(f => f.name).sort().join(',')
      const remoteFieldNames = (existing.fields as { name: string }[]).map(f => f.name).sort().join(',')

      if (localFieldNames !== remoteFieldNames) {
        console.log(`  ↑ updating fields (v${existing.version} → v${existing.version + 1})`)
        await client.templates.updateTemplate(existing.template_id, {
          fields: tpl.fields,
          identity_fields: tpl.identity_fields,
          label: tpl.label,
          description: tpl.description,
        })
        console.log(`  ✓ updated`)
      } else {
        console.log(`  ✓ exists v${existing.version} (${existing.template_id})`)
      }
    } else {
      const created = await client.templates.createTemplate({
        value: tpl.value,
        label: tpl.label,
        description: tpl.description,
        namespace: tpl.namespace,
        identity_fields: tpl.identity_fields,
        fields: tpl.fields,
      })
      console.log(`  ✓ created (${created.template_id})`)
    }
  }
}

async function main() {
  console.log('=== wip-val bootstrap ===\n')
  await bootstrapNamespace()
  await bootstrapTerminologies()
  await bootstrapTemplates()
  console.log('\n=== done ===')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
