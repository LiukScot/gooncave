# ADR 0001: TanStack Start Evaluation

## Status

Accepted

## Date

2026-05-30

## Context

Issue `#103` asked for a small TanStack Start spike before deciding whether to replace the current Vite + React frontend shell.

Current app shape:

- Fastify owns auth, cookies, API routes, worker coordination, static file serving, and SPA fallback.
- The frontend already uses TanStack Router and TanStack Query inside a Vite app.
- Local dev today is three processes: backend API, backend worker, and frontend dev server.
- Production Docker builds one backend image that serves the built frontend.

Spike evidence:

- Temporary scaffold created in `/tmp/gooncave-start-spike` with `bunx @tanstack/cli create gooncave-start-spike -y`.
- The generated Start app uses a Vite-driven dev server on port `3000`.
- Production build emits both `dist/client/*` and `dist/server/server.js`.
- Routes are file-based under `src/routes`, with root shell ownership in `src/routes/__root.tsx`.
- The scaffold errored on one post-create TanStack Intent step, which is small but still extra setup friction.

## Decision

Keep the current Vite + React frontend and Fastify backend. Do not migrate to TanStack Start now.

## Why

### Auth shell

TanStack Start can express protected routes, but this repository already has cookie-backed auth and route guards working with TanStack Router. Start does not remove the hard part here because Fastify still owns the real session boundary.

### Route setup

The app already completed the TanStack Router migration. Moving again to file-based Start routes would be a second router migration, not a net-new capability win.

### Fastify coexistence

This is the main blocker. Start's production output includes its own server bundle. GoonCave already has a Fastify server that owns:

- auth cookies
- API endpoints
- worker-triggered behavior
- static asset serving
- SPA fallback

To adopt Start, we would need one of these awkward shapes:

1. move API/auth ownership away from Fastify into Start handlers
2. proxy between a Start server and Fastify
3. keep Fastify as primary and reduce Start to an extra server artifact

All three add integration complexity without solving a current product problem.

### Docker and local dev friction

The scaffold builds both client and server artifacts. That is fine in isolation, but this repo would still need the Fastify API and worker. So the practical dev loop stays multi-process, and production Docker gets another serving decision instead of simplification.

### Rollback cost

Migration cost is high because the app would need:

- route file rewrites
- auth boundary rewiring
- Docker serving changes
- new production ownership between Start and Fastify

The gain is modest because the current stack already has the router we wanted.

## Consequences

- Keep investing in the current Vite + React frontend.
- Keep Fastify as the single backend/auth/static owner.
- Revisit Start only if we later want SSR or server functions badly enough to justify replacing the current Fastify ownership model.

## Follow-up

- The temporary spike stays out of merged history.
- Future frontend modernization should stay incremental inside the existing Vite + TanStack Router setup.
