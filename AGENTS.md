# Agent instructions

These rules apply to every code change in this repository. Apply
language- and feature-specific rules only when that language or feature
exists. Repo-specific instructions may add stricter requirements.

Goals: keep the codebase consistent, surface bugs early, give PR
reviewers (human or AI) a concrete checklist of what to verify.

PR review uses this file. A PR that violates a rule below should be
flagged or rejected with a reference to the rule it breaks.

---

## 0. Before writing code

- Read what already exists. Find a sibling file solving a similar
  problem and copy its structure, naming, and patterns.
- Match the prefix conventions of nearby code. If components are
  named `dash-*`, do not introduce `widget-*`.

## 1. Style and design system

- When the project has a design system, use its spacing, color,
  typography, surface, and breakpoint tokens. Add a token only when
  the value represents a reusable design decision.
- Prefer an existing spacing token over ad-hoc values or `calc(...)`.
  Use component-specific values when the layout cannot be expressed
  correctly with an existing token.
- Reuse a shared utility class when its semantics match. Do not reuse
  a selector only because its current visual output looks similar.
- When the project supports dark mode, new colors must adapt to every
  supported theme. Prefer semantic tokens over raw color literals.

## 2. Code organization

- Treat 500 lines as a review signal, not an automatic split. Split by
  responsibility when a file has multiple reasons to change.
- No helpers, factories, or wrappers for hypothetical future needs.
  Extract repeated logic after three concrete uses, or earlier when it
  isolates a substantial contract or risk.

## 3. Error handling

- Validate untrusted data at trust boundaries: HTTP endpoints, CLI
  args, message payloads, files, persistence reads, and third-party
  responses. Avoid redundant validation, but assert important internal
  invariants where violating them would corrupt data or hide a bug.
- Never silent-catch. Every `catch` either re-throws, returns an
  explicit error result, or logs with enough context to diagnose.
  Empty catch block = bug.
- Do not silently recover from an unexpected state. Return a useful
  error, fail visibly, or use an observable fallback defined by the
  product contract.
- Do not wrap code that cannot throw in `try/catch`.

## 4. Type safety (TypeScript projects)

- No `any` without an inline `// reason: ...` comment explaining
  why a narrower type is impossible.
- No `// @ts-ignore` or `// @ts-nocheck` in new code. Fix the type.
- Validate boundary inputs at runtime (zod, valibot, manual
  guards). Type assertions are not validation.
- Prefer `unknown` to `any` when the input shape is genuinely
  unknown.

## 5. Imports and dependencies

- Before adding a package, check the standard library and existing
  dependencies. Add a maintained package when it materially reduces
  complexity, security risk, or maintenance cost.
- Commit the lockfile (`package-lock.json`, `bun.lock`,
  `pnpm-lock.yaml`, `go.sum`, `composer.lock`). Do not delete it.
- Do not downgrade a package without a written reason in the commit
  body.
- Prefer packages from the ecosystem's normal registry over tarball
  URLs or Git refs. Document and review any source exception.
- Keep dependencies on supported, patched releases. Use automated
  update PRs when appropriate, and validate compatibility, changelogs,
  migrations, and tests before accepting an update. Track blockers for
  deferred security or major-version upgrades.

## 6. Comments

- Keep comments sparse.
- Comment only when the *why* is non-obvious: a workaround for a
  specific bug, a hidden invariant, a counter-intuitive choice.
- Do not explain *what* the code does. Identifier names and types
  already do that.
- An exported function may carry a docstring when its signature does
  not state the whole contract: units, accepted ranges, ordering
  guarantees, what happens on failure, whether an argument is mutated.
  That is the contract for callers, and it is what §17 means by keeping
  API docs in sync. One that restates the name and the types is not.
- Docstring coverage is not a target. A percentage is satisfied by
  writing `/** Builds the lookup. */` over `buildLookup()`, which adds
  nothing and still rots. Judge each one on whether a caller learns
  something from it.
- Do not write comments that reference the current task, ticket, or
  PR ("added for issue #42", "TODO before merge"). Those rot. Put
  them in the PR description.
- Remove temporary debug output and debugger statements. Intentional
  telemetry uses the project's logger and follows its privacy rules.

## 7. Commits

- Subject uses Conventional Commits: `feat:`, `fix:`, `chore:`,
  `refactor:`, `test:`, `docs:`, `perf:`, `ci:`, `security:`,
  `build:`, `style:`. Subject ≤ 72 chars.
- Subject is imperative ("add", "fix", not "added", "fixed").
- Body explains *why*, not *what*. Wrap at 72 chars.
- Put `Closes #N` / `Fixes #N` in the PR description when the PR fully
  resolves an issue. A commit may reference an issue without closing it.
- Never `--no-verify` to skip hooks.
- Do not rewrite commits that other people have reviewed or based work
  on. Never rewrite merged history.

### Issues and PRs

- Keep the current scope, decisions, tasks, and remaining work in the
  description. Use comments for review discussion, notifications, and
  timestamped events that should remain in the history.
- Before rewriting a description, re-read it and keep what is still
  valid.
- Tasks are imperative, one per line (`- [ ] Add X to Y`). The title
  says what changes, not how you got there.
- When you read an issue or PR written by someone else, read its
  comments too (`--comments`).

### Platform versions and milestones

<!-- Independent release tracks prevent a release on one platform from renumbering the others. -->
- Version PC, Android, and iOS independently using `MAJOR.MINOR.PATCH`.
- Name release milestones `<Platform> <version> — <scope>`.
- Use platform labels for the affected distributions and domain labels for the feature.
- Use platform-qualified release tags: `pc/v1.0.0`, `android/v0.1.0`, `ios/v0.1.0`.
- Keep application versions separate from server API, database, and backup-format versions.

<!-- Milestone requirements apply to owner-planned work without blocking community reports. -->
- Require a milestone for normal issues created by `LiukScot`, including issues an agent creates on the owner's behalf.
- Allow documentation, small hotfixes, and isolated maintenance issues outside milestones.
- Let other users create issues without a milestone; leave assignment to the owner unless explicitly requested.
- Do not assign a milestone or release bump merely because an external report exists.
- Assign at most one milestone per issue. Link platform-specific follow-ups when delivery spans independent release tracks.
- Before closing owner-planned work, move unfinished scope to a linked issue with a milestone, unless an exception above applies.
- Allow empty milestones. Do not put release phases in issue titles.

<!-- Planned release numbers describe future delivery; creating or triaging an issue does not release software. -->
- Increment `MINOR` and reset `PATCH` for each new minor release milestone within that platform: `1.2.1` → `1.3.0`.
- Increment `PATCH` once per delivered out-of-milestone issue, only for distributions that include the change.
- Change `MAJOR` only by explicit human decision.
- Publish a version only when its release scope and validation are complete; do not bump manifests while planning milestones.
- List changes since the previous platform release in any PR that changes its version.
- Treat PC `1.0.0` as the packaged server-based release, iOS `0.1.0` as the complete server client, and iOS `1.0.0` as standalone feature parity with server mode retained.
- Follow [the versioning policy](docs/versioning.md) and [the iOS roadmap](ios/README.md).

## 8. Tests

- When practical, start a bug fix with a regression test for the
  violated invariant. Verify that it fails for the intended reason.
  If the repository has no suitable test harness, state how the fix was
  verified instead.
- Add tests for new non-trivial behavior when a suitable test harness
  exists. Do not add tests that only restate reversible documentation or
  configuration edits.
- Test the contract (input → output), not the implementation. Tests
  that mirror the code break on every refactor.
- Prefer mocks at system boundaries such as network, filesystem, time,
  randomness, and database drivers. Mock an internal collaborator only
  when its contract is the intended isolation boundary; do not mirror
  implementation details in mocks.
- Investigate flaky tests. Do not use retries solely to hide a known
  deterministic defect.
- Tests needing network or a live DB go in an integration suite,
  not a unit suite.

## 9. Security

- Never commit secrets in code, environment files, comments, fixtures,
  logs, or commit messages. Environment templates may be committed only
  with clearly fake placeholder values.
- SQL: parametrize. Never string-concat user input into queries.
- HTML output: escape by default. Only opt out for explicitly
  trusted values, with a comment naming the source.
- Redirects: validate the target against an allowlist. Open
  redirect is a phishing primitive.
- File upload: validate MIME, size, and extension server-side.
  Never trust client-reported `Content-Type`.
- CSRF: cookie-authenticated state-changing endpoints require the
  framework's CSRF protection or an equivalent verified control.
- Minimize personal data in logs. Redact email, phone, full IP, tokens,
  and user-supplied free text unless the field is necessary and its
  retention is explicitly defined.
- When a task requires changes to authentication, authorization,
  sessions, or cryptography, keep the diff narrow and add focused
  verification and security review.

## 10. Database and migrations

- A schema change is a new migration file. Never edit a migration
  that has been merged.
- Prefer backward-compatible expand-and-contract migrations. Provide a
  safe rollback when feasible and document one-way operations.
- No destructive operations (`DROP TABLE`, `DROP COLUMN`, `DELETE`
  without `WHERE`, `TRUNCATE`) without explicit user direction.
- Evaluate indexes for foreign keys and frequent filters, joins, and
  ordering. Confirm the database's requirements and query plan instead
  of adding indexes mechanically.
- Do not run migrations from application code at startup unless the
  project has decided to. Prefer a separate migrate step.
- For large tables, plan batching, lock duration, deployment ordering,
  and backward compatibility before running schema changes or backfills.

## 11. Performance

<!-- Evita che elaborazioni accessorie aumentino la latenza o spostino il contenuto che l'utente sta leggendo. -->
- Mantieni rapide le richieste che alimentano schermate interattive. Prima di aggiungere query, download o chiamate di rete al percorso principale, prova a riusare i dati già disponibili o ad aggregare il lavoro senza aumentare la latenza. Se il lavoro accessorio è costoso, eseguilo dopo la prima risposta e aggiorna la schermata senza spostare gli elementi già mostrati. Aggiungi una richiesta separata solo quando riuso e aggregazione non possono soddisfare il contratto.
- In ogni schermata, quando arrivano nuovi elementi (anche con "Load more"), non spostare quelli già mostrati né inserire nuovi elementi prima del punto in cui si trova l'utente.
- Avoid per-item I/O in loops. Batch requests or use a relational join
  when the data source supports it.
- Do not load unbounded result sets into memory. A documented, bounded
  lookup table may be loaded whole when measurement supports it.
- Profile before optimizing. No micro-optimizations without a
  measured bottleneck.
- Cache only after measuring. Caches add bugs (staleness,
  invalidation, memory pressure); they earn their place by removing
  measured cost.

## 12. Async, concurrency, and resources

- Every Promise is awaited or deliberately detached with rejection
  handling. Comment only when the reason for detaching is non-obvious.
- Pass `AbortSignal` through long-running async functions where the
  caller might cancel.
- Do not `setTimeout`/`setInterval` without a clear cleanup path
  (component unmount, server shutdown, etc).
- Parallelize independent work when it is safe. Bound concurrency when
  the input size or downstream capacity is not strictly limited.
- Release files, sockets, database transactions, event listeners,
  subscriptions, timers, and temporary files on success, failure, and
  cancellation paths.
- Make externally visible side effects idempotent when callers or jobs
  may retry. Otherwise use an idempotency key or explicit deduplication.

## 13. CI and workflows

<!-- Mantiene le routine di audit compatibili con la gestione delle decisioni scelta per questa repository. -->
- Routine di audit schedulate (codebase analyst): ignora l'istruzione di creare o aggiornare il file delle decisioni (`decisions/<repo>.md`) per questa repo. Non crearlo e non scriverci.
- Every workflow has a top-level `permissions:` block. Default to
  `contents: read`. Widen per-job only when needed.
- Pin third-party actions to a reviewed full commit SHA. Add the release
  tag in a comment for readability, and use Dependabot or Renovate to
  propose SHA updates.
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
- Every new test must run in CI. When repository settings permit it,
  add new correctness-gating jobs to the default branch's required
  status checks as part of the same change.

## 14. Accessibility (frontend)

- Every form control has an accessible name. Use a visible `<label>`
  when appropriate, and add `name`, `type`, and `autocomplete` when
  required by the form contract.
- Use native semantic controls: buttons for actions, links for
  navigation, and form elements for input. Custom controls must support
  keyboard operation, focus, role, name, and state.
- Preserve valid accessibility behavior when refactoring. Remove or
  change `aria-*` only after verifying that the resulting semantics are
  correct and not redundant.
- Color is never the only signal. Always pair with icon, text, or
  shape.
- Image `alt` text is mandatory. Decorative images use `alt=""`.
- Preserve visible focus, sufficient contrast, and reduced-motion
  behavior when the project supports animation.

## 15. Internationalization (frontend)

- Do not hardcode user-facing strings if the repo has an i18n
  helper (`t()`, `i18n`, `useTranslation`, etc). Find it and use
  it.
- Date and number formatting goes through the locale-aware
  formatter with an explicit timezone when the contract requires one.
- Use the translation system's pluralization and interpolation features;
  do not build translated sentences by concatenating fragments.

## 16. Dead code

- Delete unused imports, exports, parameters, variables, and files
  in the same PR that makes them unused.
- Do not leave "commented-out for later" code. `git log` keeps
  history; commented blocks rot.
- Do not leave `TODO` or `FIXME` without a name and a ticket
  reference. Anonymous TODOs are abandoned by tomorrow.

## 17. Public contracts and documentation

- Preserve backward compatibility for public APIs, persisted data,
  events, and configuration unless the task explicitly includes a
  breaking change and migration path.
- Update the relevant user, contributor, architecture, operations, or
  deployment documentation when its contract changes.
- Do not write README aimed at first-time PR reviewers. They have
  `git log` and the code. Aim docs at users.
- API docs (OpenAPI, JSDoc, GoDoc) are kept in sync with the code
  in the same PR. Stale docs are worse than no docs.
- Do not edit generated files manually. Change their source and run the
  documented generator; commit generated output only when the project
  tracks it.
