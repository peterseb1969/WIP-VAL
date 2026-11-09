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

Requires a `.env` with `WIP_API_KEY_FILE` naming the WIP key file (the live
wip-deploy secrets file, read once at startup so a rotation is picked up on
restart), and optionally `WIP_BASE_URL` and `WIP_NAMESPACE`. A literal
`WIP_API_KEY` also works; the key file wins when both are set. On a WIP instance without the `wip-val` namespace the app
shows a one-click bootstrap screen (`/api/bootstrap/status` + `/run`) that
provisions namespace, terminologies, and templates from `data-model/*.json`;
the same idempotent provisioner is also runnable headless with
`npx tsx data-model/bootstrap.ts`.

## Development with wip-deploy

This app satisfies the wip-deployable app contract
(`docs/wip-deployable-app-contract.md`), so it runs under wip-deploy with no
manual env patching. It is served at the root of its own origin,
`https://<label>.<host>/` with label `wip-val`; there is no base path:

```bash
wip-deploy install --target dev --app wip-val \
  --app-source wip-val=~/Development/WIP-VAL
open https://wip-val.wip.localhost:8443/
```

The contract surface lives in: `Dockerfile.dev` + `docker-entrypoint-dev.sh`
(dev image, hash-gated `npm ci`), `Dockerfile` (two-stage production build at
Vite's default base `/`, tsx started by path), `vite.config.ts` (default base,
`host: 0.0.0.0`, dev proxy → `:3015`), `server/index.ts` (all routes mounted
at `/`, `trust proxy`, production `dist/` static serve with an SPA fallback
that answers 404 JSON under `/api`, `/auth`, `/wip`, `/server-api` and
`/mcp`, gateway-aware `/api/me`), `src/App.tsx` (`useAppSessionRenewal`
keeps the gateway's app session alive), and every client fetch prefixed with
`import.meta.env.BASE_URL`. The matching manifest is
`World-in-a-Pie/apps/wip-val/wip-app.yaml`.
