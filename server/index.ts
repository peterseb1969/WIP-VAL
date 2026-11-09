import 'dotenv/config'  // Must be first — loads .env before any other module reads process.env
import './load-api-key.js'  // Second — resolves WIP_API_KEY_FILE into WIP_API_KEY
import path from 'path'
import { fileURLToPath } from 'url'
import express, { Router } from 'express'
import cors from 'cors'
import session from 'express-session'
import { initAgent, ask } from './agent.js'
import { initAuth, requireAuth, handleCallback, handleLogout } from './auth.js'
import { createUploadHandler, createSaveHandler } from './parse-template.js'
import { createSaveTemplateHandler } from './save-template.js'
import {
  listValTemplatesHandler,
  getValTemplateHandler,
  patchValTemplateColumnsHandler,
  patchValTemplateFieldsHandler,
  deleteValTemplateHandler,
  downloadTemplateFileHandler,
} from './val-templates.js'
import { createValidateHandler } from './validate.js'
import { createExportTemplateHandler, createExportPreflightHandler } from './export-template.js'
import {
  listValRunsHandler,
  getValRunHandler,
  downloadRunFileHandler,
  deleteValRunHandler,
  revalidateRunsHandler,
} from './val-runs.js'
import { checkBootstrapStatus, runBootstrap, type BootstrapProgress } from './bootstrap.js'
import { WIP_NAMESPACE } from './wip-api.js'

// 3015: WIP-VAL's assigned Express port (3001=react-console, 3011/3012 taken,
// 3014=wip-aa — coordinate via the apps/ manifests before changing).
const PORT = parseInt(process.env.PORT || '3015')

// Path prefixes that belong to APIs, never to SPA pages (see the fallback).
const API_PREFIX_PATTERN = /^\/(api|auth|wip|server-api|mcp)(\/|$)/
const app = express()
const router = Router()

// Trust the reverse proxy (Caddy/ingress) for HTTPS termination.
app.set('trust proxy', 1)

app.use(cors())
app.use(express.json())

// --- Session (required for OIDC auth) ---
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: '/',
  },
}))

// --- Auth routes ---
router.get('/auth/callback', (req, res) => { handleCallback(req, res) })
router.get('/auth/logout', handleLogout)

// --- Auth middleware (no-op when OIDC_ISSUER is not set) ---
router.use(requireAuth())

// --- Health (must answer locally without WIP reachable) ---
router.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// --- Runtime app config: the client-visible per-deployment values. An
// allowlist only — never an env dump, never a secret (every browser sees it).
router.get('/api/app-config', (_req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json({ namespace: WIP_NAMESPACE })
})

// --- Bootstrap (provision the wip-val namespace on a fresh WIP instance) ---
router.get('/api/bootstrap/status', async (_req, res) => {
  res.json(await checkBootstrapStatus())
})

router.post('/api/bootstrap/run', async (_req, res) => {
  const steps: BootstrapProgress[] = []
  try {
    await runBootstrap(e => steps.push(e))
    res.json({ ok: true, steps })
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message, steps })
  }
})

// --- Ask endpoint ---
router.post('/api/ask', async (req, res) => {
  const { question, sessionId } = req.body
  if (!question) {
    res.status(400).json({ error: 'question is required' })
    return
  }
  try {
    const result = await ask(question, sessionId)
    res.json(result)
  } catch (err: any) {
    console.error('Ask error:', err)
    res.status(500).json({ error: err.message || 'Internal error' })
  }
})

// --- User info — gateway headers (X-WIP-User) first, then OIDC session ---
router.get('/api/me', (req, res) => {
  const gwUser = req.headers['x-wip-user'] as string | undefined
  if (gwUser) {
    const groups = (req.headers['x-wip-groups'] as string || '').split(',').filter(Boolean)
    res.json({ email: gwUser, groups, method: 'gateway' })
    return
  }
  if (req.session.user) {
    res.json(req.session.user)
    return
  }
  res.json({ anonymous: true })
})

// --- Template parser ---
router.post('/api/template-parser/upload', ...createUploadHandler())
router.post('/api/template-parser/save-legacy', createSaveHandler())
router.post('/api/template-parser/save', createSaveTemplateHandler())

// --- Validation templates ---
router.get('/api/val-templates', listValTemplatesHandler())
router.get('/api/val-templates/:id', getValTemplateHandler())
router.get('/api/val-templates/:id/download', downloadTemplateFileHandler())
router.patch('/api/val-templates/:id/columns', patchValTemplateColumnsHandler())
router.patch('/api/val-templates/:id/fields', patchValTemplateFieldsHandler())
router.delete('/api/val-templates/:id', deleteValTemplateHandler())

// --- Template → Excel export (operates on a raw WIP template_id) ---
router.get('/api/templates/:id/export/preflight', createExportPreflightHandler())
router.get('/api/templates/:id/export', createExportTemplateHandler())

// --- Document validation ---
router.post('/api/validate', ...createValidateHandler())

// --- Validation runs ---
router.get('/api/val-runs', listValRunsHandler())
router.post('/api/val-runs/revalidate', revalidateRunsHandler())
router.get('/api/val-runs/:id', getValRunHandler())
router.get('/api/val-runs/:id/download', downloadRunFileHandler())
router.delete('/api/val-runs/:id', deleteValRunHandler())

// --- In production, serve the built frontend from dist/ with SPA fallback ---
if (process.env.NODE_ENV === 'production') {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const distPath = path.resolve(__dirname, '..', 'dist')
  router.use(express.static(distPath))
  const indexHtml = path.join(distPath, 'index.html')
  // SPA fallback for page routes only. An unmatched path under an API prefix
  // answers 404 JSON for any method, never index.html: a JSON client that
  // reaches a route this server lacks must see a 404, not a 200 page it then
  // fails to parse.
  router.all(API_PREFIX_PATTERN, (_req, res) => { res.status(404).json({ error: 'not found' }) })
  router.get('/', (_req, res) => { res.sendFile(indexHtml) })
  router.get('{*path}', (_req, res) => { res.sendFile(indexHtml) })
}

// The app is served at the root of its own origin: everything mounts at '/'.
app.use('/', router)

// --- Start ---
async function main() {
  await initAuth()
  // The agent backs only /api/ask; a failure there must not keep the app
  // (and its WIP-independent healthcheck) from starting.
  try {
    await initAgent()
  } catch (err) {
    console.warn(`⚠ agent init failed — /api/ask will be unavailable: ${(err as Error).message}`)
  }
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`)
  })
}

main().catch(err => {
  console.error('Failed to start:', err)
  process.exit(1)
})
