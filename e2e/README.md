# gooncave e2e

Browser-level regression tests for the gooncave SPA. Implemented with
Playwright (chromium only) hitting a live stack on `http://localhost:4100`.

## When to run

CI runs this suite automatically on:

- pushes to `main`, and
- pull requests labelled `run-e2e`.

Day-to-day PRs **do not** trigger the suite — it adds ~1 minute of CI per run
and the unit-level coverage in `backend/test/` and `frontend/test/` already
catches the bulk of regressions.

## Local run

Two prerequisites: a live stack and Chromium.

```bash
# 1. start the stack (pick whichever you prefer)
docker compose up -d api               # production image
# or
npm run dev                             # dev mode at :5174 + :4100

# 2. install browsers (first time only)
npm install --prefix e2e
npx --prefix e2e playwright install --with-deps chromium

# 3. run
npm test --prefix e2e
# or, with the inspector UI:
npm run test:ui --prefix e2e
```

`E2E_BASE_URL` overrides the target if you're not on `:4100`.

## Spec coverage

| Spec | What it pins |
| --- | --- |
| `auth-flow.spec.ts` | Register → logged-in shell → logout → back to login form. Sanity for the protected `/auth/me` endpoint. |
| `cookie-secure-regression.spec.ts` | Issue #67. Login over plain HTTP must survive a reload. Browser-level proof that `Secure` is off when the deployment serves http. |
| `auto-logout-on-401.spec.ts` | If the session evaporates mid-session, the SPA snaps back to the login form via `gooncave:auth-required`. |

## Time budget

The whole suite must complete in under 3 minutes (project mandate). Current
run-time on CI is ~1 minute including stack startup. If this creeps up:

- raise `workers` in `playwright.config.ts` (specs are independent),
- shard with `--shard=<i>/<n>` across matrix jobs,
- or trim the spec set.

## Adding a spec

1. Create a fresh user with `newUser()` from `fixtures/users.ts` so parallel
   runs don't collide.
2. Stick to user-visible flows. If you can pin the behaviour with an
   `app.inject()` test in `backend/test/`, do that instead — it's 100×
   faster.
