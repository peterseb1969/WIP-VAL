# WIP-VAL

Spreadsheet validation app on World In a Pie. Parses vendor / C02 Excel
workbooks into WIP-native templates, validates uploaded data against them
(delegating to WIP's own document validation), records validation runs, and
exports WIP templates back out to Excel (vendor format).

- **Server:** Express (`tsx`), port **3015**.
- **Client:** Vite + React SPA, dev port **5181**.
- **WIP namespace:** `wip-val`.

## Development

```bash
npm install
npm run dev        # Express :3015 + Vite :5181 concurrently
```

Requires a `.env` with `WIP_API_KEY` (and optionally `WIP_BASE_URL`,
`WIP_NAMESPACE`). Bootstrap the data model with `npx tsx data-model/bootstrap.ts`.

## Development with wip-deploy

This app satisfies the wip-deployable app contract
(`FR-YAC/papers/wip-deployable-app-contract.md`), so it runs under wip-deploy
with no manual env patching:

```bash
wip-deploy install --target dev --app wip-val \
  --app-source wip-val=~/Development/WIP-VAL
open https://localhost:8443/apps/wip-val/
```

The contract surface lives in: `Dockerfile.dev` + `docker-entrypoint-dev.sh`
(dev image, hash-gated `npm ci`), `Dockerfile` (two-stage production build,
`VITE_BASE_PATH` baked in), `vite.config.ts` (`base` from
`VITE_BASE_PATH`/`APP_BASE_PATH`, `host: 0.0.0.0`, dev proxy → `:3015`),
`server/index.ts` (all routes on an `express.Router()` mounted under
`APP_BASE_PATH`, `trust proxy`, production `dist/` static serve + SPA fallback,
gateway-aware `/api/me`), and every client fetch prefixed with
`import.meta.env.BASE_URL`. The matching manifest is
`World-in-a-Pie/apps/wip-val/wip-app.yaml`. In standalone dev, `APP_BASE_PATH`
defaults to `/` so behavior is unchanged.
