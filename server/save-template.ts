import type { Request, Response, RequestHandler } from 'express'
import { toSlug } from './util.js'
import {
  getOrCreateTerminology,
  upsertTerms,
  getTemplateIdByValue,
  createDocument,
  WIP_NAMESPACE,
} from './wip-api.js'
import { createWipClient } from '@wip/client'
import type { ParsedField, SpreadsheetFormat } from './parsed-template.js'

const WIP_BASE = process.env.WIP_BASE_URL || 'https://localhost:8443'

function wip() {
  const key = process.env.WIP_API_KEY
  if (!key) throw new Error('WIP_API_KEY not set')
  return createWipClient({ baseUrl: WIP_BASE, auth: { type: 'api-key', key } })
}

interface SaveTemplateRequest {
  name: string
  description: string
  format: SpreadsheetFormat
  fields: ParsedField[]
  identityFields: string[]
  wipFileId?: string
  templateMeta?: Record<string, string>
  datasetMeta?: Record<string, string>
  identifierPattern?: string
}

function lovTerminologyValue(templateName: string, fieldName: string): string {
  const tSlug = toSlug(templateName)
  const fSlug = toSlug(fieldName)
  return `LOV_${tSlug}_${fSlug}`.slice(0, 80)
}

export function createSaveTemplateHandler(): RequestHandler {
  return async (req: Request, res: Response): Promise<void> => {
    const body = req.body as SaveTemplateRequest

    if (!body.name) {
      res.status(400).json({ error: 'name is required' })
      return
    }
    if (!Array.isArray(body.fields) || body.fields.length === 0) {
      res.status(400).json({ error: 'fields must be a non-empty array' })
      return
    }

    try {
      const createdBy = (req.session as { user?: { email?: string } })?.user?.email ?? 'wip-val'

      // 1. Create/upsert LOV terminologies for term-typed fields.
      // Fields can legitimately share a terminology (vendor code lists), so
      // dedupe by terminology value first — one get-or-create per unique
      // value. Creating the same value concurrently races: the platform's
      // atomic claim gate rejects all but one ("already exists / collision
      // across namespaces").
      const terminologyMap = new Map<string, string>()
      const terminologiesCreated: string[] = []

      const termFields = body.fields.filter(f => f.type === 'term' && (f.terminologyValues?.length ?? 0) > 0)
      const byTermValue = new Map<string, { label: string; values: Set<string>; fieldNames: string[] }>()
      for (const field of termFields) {
        const termValue = field.terminologyName
          ? toSlug(field.terminologyName)
          : lovTerminologyValue(body.name, field.name)
        const group = byTermValue.get(termValue) ?? { label: field.label, values: new Set<string>(), fieldNames: [] }
        for (const v of field.terminologyValues ?? []) group.values.add(v)
        group.fieldNames.push(field.name)
        byTermValue.set(termValue, group)
      }

      await Promise.all(
        [...byTermValue.entries()].map(async ([termValue, group]) => {
          const term = await getOrCreateTerminology(WIP_NAMESPACE, termValue, group.label)
          await upsertTerms(term.terminology_id, WIP_NAMESPACE, [...group.values])
          for (const fieldName of group.fieldNames) terminologyMap.set(fieldName, termValue)
          terminologiesCreated.push(termValue)
        })
      )

      // 2. Build WIP template field definitions
      const wipFields = body.fields.map(field => {
        const wipField: Record<string, unknown> = {
          name: field.name,
          label: field.label,
          type: field.type,
          mandatory: field.mandatory,
          metadata: {},
        }
        if (field.type === 'term' && terminologyMap.has(field.name)) {
          wipField.terminology_ref = terminologyMap.get(field.name)
        }
        if (field.semanticType) {
          wipField.semantic_type = field.semanticType
        }
        const validation: Record<string, unknown> = {}
        if (field.pattern) validation.pattern = field.pattern
        if (field.minimum != null) validation.minimum = field.minimum
        if (field.maximum != null) validation.maximum = field.maximum
        if (Object.keys(validation).length > 0) wipField.validation = validation
        if (field.metadata && Object.keys(field.metadata).length > 0) {
          wipField.metadata = field.metadata
        }
        return wipField as unknown
      }) as never[]

      // 3. Create or update the WIP template
      const templateValue = toSlug(body.name)
      const client = wip()
      let wipTemplateId: string

      try {
        const created = await client.templates.createTemplate({
          value: templateValue,
          label: body.name,
          description: body.description || '',
          namespace: WIP_NAMESPACE,
          identity_fields: body.identityFields,
          fields: wipFields,
          metadata: {
            domain: 'validation',
            custom: {
              source_format: body.format,
              ...(body.identifierPattern ? { identifier_pattern: body.identifierPattern } : {}),
              ...(body.templateMeta ? { template_meta: body.templateMeta } : {}),
              ...(body.datasetMeta ? { dataset_meta: body.datasetMeta } : {}),
            },
          },
        })
        wipTemplateId = created.id!
      } catch (createErr: unknown) {
        const msg = createErr instanceof Error ? createErr.message : String(createErr)
        if (!msg.includes('already exists')) throw createErr
        // Template value exists — find it and create a new version
        const list = await client.templates.listTemplates({ namespace: WIP_NAMESPACE, page_size: 200 })
        const existing = list.items.find(t => t.value === templateValue)
        if (!existing) throw createErr
        await client.templates.updateTemplate(existing.template_id, {
          fields: wipFields,
          identity_fields: body.identityFields,
        })
        wipTemplateId = existing.template_id
      }

      // 4. Create VAL_TEMPLATE registry document
      const valTemplateId = await getTemplateIdByValue(WIP_NAMESPACE, 'VAL_TEMPLATE')

      const templateData: Record<string, unknown> = {
        name: body.name,
        description: body.description || '',
        wip_template_id: wipTemplateId,
        wip_template_value: templateValue,
        format: body.format,
        field_count: body.fields.length,
        created_by: createdBy,
      }
      if (body.wipFileId) {
        try {
          const fileMeta = await client.files.getFile(body.wipFileId)
          if (fileMeta.status === 'active') {
            templateData.source_file = body.wipFileId
          }
        } catch {
          // File deleted or inaccessible — skip the reference
        }
      }

      const templateDoc = await createDocument(valTemplateId, WIP_NAMESPACE, templateData, createdBy)

      res.json({
        templateDocumentId: templateDoc.document_id,
        wipTemplateId,
        wipTemplateValue: templateValue,
        fieldCount: body.fields.length,
        terminologiesCreated,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('Save template error:', message)
      res.status(500).json({ error: `Failed to save template: ${message}` })
    }
  }
}
