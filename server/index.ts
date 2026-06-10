import 'dotenv/config'  // Must be first — loads .env before any other module reads process.env
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

// APP_BASE_PATH — external path prefix when deployed behind wip-router
// (e.g. /apps/wip-val). Everything mounts on a Router under it so cookies,
// OIDC redirects, and asset URLs all match. '/' in standalone dev.
// See FR-YAC/papers/wip-deployable-app-contract.md.
const BASE_PATH = (process.env.APP_BASE_PATH || '').replace(/\/$/, '') || '/'

// 3015: WIP-VAL's assigned Express port (3001=react-console, 3011/3012 taken,
// 3014=wip-aa — coordinate via the apps/ manifests before changing).
const PORT = parseInt(process.env.PORT || '3015')
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
    path: BASE_PATH.endsWith('/') ? BASE_PATH : `${BASE_PATH}/`,
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
  router.get('/', (_req, res) => { res.sendFile(indexHtml) })
  router.get('{*path}', (_req, res) => { res.sendFile(indexHtml) })
}

// Mount everything at BASE_PATH
app.use(BASE_PATH, router)

// --- Start ---
async function main() {
  await initAuth()
  await initAgent()
  app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`)
    if (BASE_PATH !== '/') {
      console.log(`  base path: ${BASE_PATH}`)
    }
  })
}

main().catch(err => {
  console.error('Failed to start:', err)
  process.exit(1)
})
