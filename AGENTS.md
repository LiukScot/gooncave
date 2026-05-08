# Agent instructions

These rules apply to every code change in this repository.

Goals: keep the codebase consistent, surface bugs early, give PR
reviewers (human or AI) a concrete checklist of what to verify.

PR review uses this file. A PR that violates a rule below should be
flagged or rejected with a reference to the rule it breaks.

---

## 0. How to approach work

These rules govern *how* you work, not *what* you write. They apply
before any of the rules below.

- **Surface assumptions before coding**. State them explicitly. If
  the request has 2+ plausible interpretations and the code would
  differ, stop and ask one clarifying question. Don't pick silently.
- **Plan multi-step tasks with verify steps**. State the plan as
  `step → verify`. Strong success criteria let the work loop
  without constant clarification.
- **Bug fix = test first**. Write a failing test that reproduces
  the bug, then make it pass. Same pattern for "make X validate":
  write the test for invalid input, then implement.
- **Trace test**: every changed line should map directly to the
  request. If a line doesn't, justify it or remove it. PR reviewers
  apply this rule.
- **Push back if a simpler approach exists**. The user is not
  always right about scope or implementation. If the request can
  be solved with less code or a different angle, say so before
  building.

## 1. Before writing code

- Read what already exists. Find a sibling file solving a similar
  problem and copy its structure, naming, and patterns.
- Match the prefix conventions of nearby code. If components are
  named `dash-*`, do not introduce `widget-*`.
- Do not introduce a new layer, abstraction, or directory unless the
  problem cannot be expressed with what is already here.

## 2. Style and design system

- Spacing, color, typography, surface come from the project's design
  tokens (CSS variables, theme files, Tailwind config, design system
  page). Use the existing tokens. Do not add ad-hoc px/rem, hex, or
  one-off media queries.
- Do not introduce `calc(...)` for spacing. Pick a token that fits
  the rhythm; if none fits, ask before adding a new token.
- Reuse shared utility classes before creating new ones. Search the
  existing prefix conventions (`.dash-*`, `.detail-*`, `.status-*`,
  whatever this repo uses) and reuse the selector.
- Dark mode: any new color rule either uses tokens that auto-adapt
  or has a `:root[data-theme="dark"]` (or equivalent) counterpart.
  Raw hex breaks dark mode.

## 3. Code organization

- Keep files under ~500 lines. Split by concern, not line count.
- Three similar lines is fine. Abstract on the fourth instance, not
  the second.
- No helpers, factories, or wrappers for hypothetical future needs.
  Add them when there are at least three concrete callers.
- One change per PR. Drive-by refactors live in their own PR.

## 4. Error handling

- Validate input only at system boundaries: HTTP endpoints, CLI
  args, message queue payloads, file uploads, third-party API
  responses. Internal modules trust each other.
- Never silent-catch. Every `catch` either re-throws, returns an
  explicit error result, or logs with enough context to diagnose.
  Empty catch block = bug.
- Do not add fallbacks for "shouldn't happen" branches. Let the
  code crash visibly with a useful message. Hidden recovery hides
  bugs.
- Do not wrap code that cannot throw in `try/catch`.

## 5. Type safety (TypeScript projects)

- No `any` without an inline `// reason: ...` comment explaining
  why a narrower type is impossible.
- No `// @ts-ignore` or `// @ts-nocheck` in new code. Fix the type.
- Validate boundary inputs at runtime (zod, valibot, manual
  guards). Type assertions are not validation.
- Prefer `unknown` to `any` when the input shape is genuinely
  unknown.

## 6. Imports and dependencies

- Do not add a dependency for what 5 lines of stdlib do.
- Before adding a package, search existing `dependencies` for
  something that already covers it.
- Commit the lockfile (`package-lock.json`, `bun.lock`,
  `pnpm-lock.yaml`, `go.sum`, `composer.lock`). Do not delete it.
- Do not downgrade a package without a written reason in the commit
  body.
- Do not pin to a tarball URL or git ref unless no npm-published
  alternative exists. CDN/git deps bypass Dependabot.

## 7. Comments

- Default: write no comment.
- Comment only when the *why* is non-obvious: a workaround for a
  specific bug, a hidden invariant, a counter-intuitive choice.
- Do not explain *what* the code does. Identifier names and types
  already do that.
- Do not write comments that reference the current task, ticket, or
  PR ("added for issue #42", "TODO before merge"). Those rot. Put
  them in the PR description.
- Never commit `console.log`, `print`, `debug!`, `dd()`, leftover
  debugger statements.

## 8. Commits

- Subject uses Conventional Commits: `feat:`, `fix:`, `chore:`,
  `refactor:`, `test:`, `docs:`, `perf:`, `ci:`, `security:`,
  `build:`, `style:`. Subject ≤ 72 chars.
- Subject is imperative ("add", "fix", not "added", "fixed").
- One concern per commit. Don't bundle unrelated changes.
- Body explains *why*, not *what*. Wrap at 72 chars.
- Reference issues with `Closes #N` / `Fixes #N` so they auto-close.
- Never `--no-verify` to skip hooks.
- Do not amend commits that have been pushed and merged or reviewed.

## 9. Tests

- New non-trivial logic gets a test. Trivial = no branches, no I/O.
- Test the contract (input → output), not the implementation. Tests
  that mirror the code break on every refactor.
- Mock only at system boundaries (network, FS, time, randomness, DB
  driver). Mocking your own modules tests the mock, not the code.
- Fix flaky tests; do not retry-loop them. Flake = real bug.
- Tests needing network or a live DB go in an integration suite,
  not a unit suite.

## 10. Security

- No secrets in code, committed env files, comments, fixtures, log
  output, or commit messages. `.env*`, `*.pem`, `*.key`, `*.p12`
  are never committed.
- SQL: parametrize. Never string-concat user input into queries.
- HTML output: escape by default. Only opt out for explicitly
  trusted values, with a comment naming the source.
- Redirects: validate the target against an allowlist. Open
  redirect is a phishing primitive.
- File upload: validate MIME, size, and extension server-side.
  Never trust client-reported `Content-Type`.
- Authentication, authorization, sessions, crypto: do not modify
  unless the task is explicitly auth/security work. High risk;
  out-of-scope changes get rejected.
- CSRF: state-changing endpoints require a CSRF token (or
  `SameSite=Strict` cookie + Origin check) unless documented as
  public.
- PII / personal data in logs: redact. Email, phone, full IP,
  user-supplied free text — none of these belong in production
  logs unredacted.

## 11. Database and migrations

- A schema change is a new migration file. Never edit a migration
  that has been merged.
- Migrations are reversible (up + down) when feasible. Document the
  why if a migration is one-way.
- No destructive operations (`DROP TABLE`, `DROP COLUMN`, `DELETE`
  without `WHERE`, `TRUNCATE`) without explicit user direction.
- Add an index for new foreign keys and for columns used in
  frequent `WHERE` / `ORDER BY`.
- Do not run migrations from application code at startup unless the
  project has decided to. Prefer a separate migrate step.

## 12. Performance

- No N+1: prefer `JOIN` or batch fetch over a per-item query in a
  loop.
- Do not load entire tables into memory. Paginate.
- Profile before optimizing. No micro-optimizations without a
  measured bottleneck.
- Cache only after measuring. Caches add bugs (staleness,
  invalidation, memory pressure); they earn their place by removing
  measured cost.

## 13. Async and concurrency

- Every Promise is awaited or explicitly `void`'d with a comment
  ("// fire and forget: logging, ok to drop").
- Pass `AbortSignal` through long-running async functions where the
  caller might cancel.
- Do not `setTimeout`/`setInterval` without a clear cleanup path
  (component unmount, server shutdown, etc).
- No `await` inside a tight loop if the operation is parallelizable.
  Use `Promise.all` / `Promise.allSettled`.

## 14. CI and workflows

- Every workflow has a top-level `permissions:` block. Default to
  `contents: read`. Widen per-job only when needed.
- Pin third-party actions to a commit SHA, not a floating tag. Tags
  can be moved.
- Never interpolate user-controlled input directly into `run:`
  blocks. Pipe through `env:`:

  ```yaml
  env:
    BODY: ${{ github.event.issue.body }}
  run: echo "$BODY"
  ```

  `${{ github.event.issue.body }}` placed directly in `run:` is
  shell injection.
- Do not skip CI hooks (`--no-verify`, `[skip ci]`, `[ci skip]`)
  without an explicit reason in the PR description.

## 15. Accessibility (frontend)

- Form inputs: every input has `name`, `id`, `type`, and a matching
  `<label for="...">`. Add `autocomplete` where the field maps to
  a standard token (`email`, `current-password`, `tel`, etc).
- Interactive elements: `<button>`, `<a>`, `<input>` — never a
  `<div>` with `onClick`. Keyboard users cannot reach `<div
  onClick>`.
- Do not remove `aria-*` attributes when refactoring. They are
  there for a reason; ask before deleting.
- Color is never the only signal. Always pair with icon, text, or
  shape.
- Image `alt` text is mandatory. Decorative images use `alt=""`.

## 16. Internationalization (frontend)

- Do not hardcode user-facing strings if the repo has an i18n
  helper (`t()`, `i18n`, `useTranslation`, etc). Find it and use
  it.
- Date and number formatting goes through the locale-aware
  formatter, not `toString`.

## 17. Dead code

- Delete unused imports, exports, parameters, variables, and files
  in the same PR that makes them unused.
- Do not leave "commented-out for later" code. `git log` keeps
  history; commented blocks rot.
- Do not leave `TODO` or `FIXME` without a name and a ticket
  reference. Anonymous TODOs are abandoned by tomorrow.

## 18. Documentation

- Update README only when the change is visible to users (CLI
  flags, install steps, env vars, breaking API).
- Do not write README aimed at first-time PR reviewers. They have
  `git log` and the code. Aim docs at users.
- API docs (OpenAPI, JSDoc, GoDoc) are kept in sync with the code
  in the same PR. Stale docs are worse than no docs.

## 19. PR scope

- Do exactly what the task asks. Nothing more.
- A bug fix does not need surrounding cleanup. File a follow-up
  issue for the cleanup.
- A one-shot operation does not need a helper function "for the
  future". Add it when there is a future caller.
- If you discover an unrelated bug while working, file an issue
  and link it. Do not silently fix it in this PR.
