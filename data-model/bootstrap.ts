/**
 * CLI wrapper for the idempotent wip-val bootstrap.
 *
 * Usage: npx tsx data-model/bootstrap.ts
 *
 * The provisioning logic lives in server/bootstrap.ts (shared with the
 * /api/bootstrap/* endpoints); seeds are the *.json files in this directory.
 * Safe to re-run: creates only missing entities, updates templates when
 * fields change.
 */

import 'dotenv/config'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const { runBootstrap } = await import('../server/bootstrap.js')

console.log('=== wip-val bootstrap ===\n')
runBootstrap(e => console.log(`→ [${e.step}] ${e.detail}`))
  .then(() => console.log('\n=== done ==='))
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
