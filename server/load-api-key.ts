/**
 * Resolve the WIP API key from WIP_API_KEY_FILE at startup.
 *
 * Run outside the deployer, .env names a key FILE (the live wip-deploy
 * secrets file) rather than a baked key, so a rotation or redeploy is picked
 * up on restart. Every module in this server reads process.env.WIP_API_KEY,
 * so the file's contents are copied there once, before those modules load.
 * When the file is set it wins over a literal WIP_API_KEY.
 *
 * Under wip-deploy the deployer injects WIP_API_KEY (the app's own key) and
 * sets no WIP_API_KEY_FILE, so this module changes nothing there.
 *
 * Import it immediately after 'dotenv/config'.
 */
import { readFileSync } from 'fs'

const keyFile = process.env.WIP_API_KEY_FILE
if (keyFile) {
  try {
    const key = readFileSync(keyFile, 'utf8').trim()
    if (key) {
      process.env.WIP_API_KEY = key
    } else {
      console.warn(`[wip] WIP_API_KEY_FILE ${keyFile} is empty; WIP calls will fail`)
    }
  } catch (err) {
    console.warn(`[wip] cannot read WIP_API_KEY_FILE ${keyFile}: ${(err as Error).message}`)
  }
}
