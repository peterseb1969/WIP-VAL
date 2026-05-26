/**
 * Idempotent bootstrap for the wip-val namespace.
 *
 * Usage: npx tsx data-model/bootstrap.ts
 *
 * Safe to re-run: uses PUT for namespace (upsert), on_conflict=validate for
 * terminologies/templates. Skips already-existing entities without error.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

const WIP_API_KEY =
  process.env.WIP_API_KEY || (() => { throw new Error("WIP_API_KEY not set"); })();
const WIP_BASE =
  process.env.WIP_BASE_URL || "https://localhost:8443";

const headers = {
  "Content-Type": "application/json",
  "X-API-Key": WIP_API_KEY,
};

// Node doesn't reject self-signed certs by default for fetch, but we replicate
// the NODE_TLS_REJECT_UNAUTHORIZED=0 pattern used by the dev server.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function wip<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${WIP_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as T;
}

const ns = JSON.parse(readFileSync(join(__dir, "namespace.json"), "utf8"));
const terminologies: TermSeed[] = JSON.parse(readFileSync(join(__dir, "terminologies.json"), "utf8"));
const templates: Record<string, unknown>[] = JSON.parse(readFileSync(join(__dir, "templates.json"), "utf8"));

interface TermSeed {
  value: string;
  label: string;
  description: string;
  namespace: string;
  terms: { value: string; label: string; description: string; sort_order: number }[];
}

async function bootstrapNamespace() {
  console.log(`→ namespace ${ns.prefix}`);
  await wip("PUT", `/api/registry/namespaces/${ns.prefix}`, {
    description: ns.description,
    isolation_mode: ns.isolation_mode,
    deletion_mode: ns.deletion_mode,
  });
  console.log(`  ✓ namespace upserted`);
}

async function bootstrapTerminologies() {
  for (const t of terminologies) {
    console.log(`→ terminology ${t.value}`);
    const existing = await fetch(
      `${WIP_BASE}/api/terminologies/${t.namespace}/${t.value}`,
      { headers }
    );
    let terminologyId: string;
    if (existing.ok) {
      const data = await existing.json() as { terminology_id: string };
      terminologyId = data.terminology_id;
      console.log(`  ✓ exists (${terminologyId})`);
    } else {
      const created = await wip<{ terminology_id: string }>("POST", "/api/terminologies", {
        value: t.value,
        label: t.label,
        description: t.description,
        namespace: t.namespace,
      });
      terminologyId = created.terminology_id;
      console.log(`  ✓ created (${terminologyId})`);
    }

    // Create terms idempotently
    const existingTermsRes = await fetch(
      `${WIP_BASE}/api/terminologies/${terminologyId}/terms?page_size=200`,
      { headers }
    );
    const existingTerms = existingTermsRes.ok
      ? ((await existingTermsRes.json()) as { items: { value: string }[] }).items.map(x => x.value)
      : [];

    const newTerms = t.terms.filter(term => !existingTerms.includes(term.value));
    if (newTerms.length > 0) {
      await wip("POST", `/api/terminologies/${terminologyId}/terms`, newTerms);
      console.log(`  + ${newTerms.length} term(s) created`);
    } else {
      console.log(`  - all ${t.terms.length} term(s) already exist`);
    }
  }
}

async function bootstrapTemplates() {
  for (const t of templates) {
    console.log(`→ template ${t.value}`);
    const existing = await fetch(
      `${WIP_BASE}/api/templates/${t.namespace}/${t.value}`,
      { headers }
    );
    if (existing.ok) {
      const data = await existing.json() as { template_id: string; version: number };
      console.log(`  ✓ exists v${data.version} (${data.template_id})`);
    } else {
      const created = await wip<{ id: string }>("POST", "/api/templates", t);
      console.log(`  ✓ created (${created.id})`);
    }
  }
}

async function main() {
  console.log("=== wip-val bootstrap ===\n");
  await bootstrapNamespace();
  await bootstrapTerminologies();
  await bootstrapTemplates();
  console.log("\n=== done ===");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
