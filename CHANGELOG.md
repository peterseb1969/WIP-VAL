# Changelog

## Unreleased

### Changed
- Served at the root of its own origin (`https://wip-val.<host>/`), per the
  current app contract. Vite builds with its default base `/`; the server
  mounts every route at `/`; `APP_BASE_PATH` / `VITE_BASE_PATH` are gone from
  the Vite config, server, Dockerfile and CI build. An image built before this
  change (for `/apps/wip-val/`) does not load on a current install.
- Production and dev images use `node:24-alpine`; the production image starts
  tsx by path (`./node_modules/.bin/tsx`), so it never fetches from npm.

### Added
- `useAppSessionRenewal` in `App`: keeps the gateway's app session alive, so
  an open tab's API calls keep working past the session lifetime.
- `GET /api/app-config` (`{namespace}`, `no-store`).
- The server reads its WIP key from `WIP_API_KEY_FILE` at startup (the key
  file wins over a literal `WIP_API_KEY`); the headless bootstrap does too.

### Fixed
- The SPA fallback answers 404 JSON for unmatched paths under `/api`, `/auth`,
  `/wip`, `/server-api` and `/mcp` instead of returning `index.html` with 200.
- Bootstrap status reports `wip_unreachable` when listing the namespace's
  templates fails (e.g. a Registry outage, 503), instead of `needs_bootstrap`,
  which would have offered to re-seed a live namespace.
- An agent (MCP) start-up failure no longer stops the server: `/api/ask`
  reports the agent unavailable and the rest of the app, including the
  healthcheck, runs.
