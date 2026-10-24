version: 20
- always update version (+1) when editing this file

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

- Before changing files for a platform, read the relevant platform roadmap,
  architecture, build, and validation documentation in this repository. Resolve
  any documented decision gate before implementing one of its alternatives.
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
- Commit the lockfile (`package-lock.json`,
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
- Keep a diagnostic that helped find a bug, behind Developer mode
  (Settings → Extra): in the core, check `developer_mode()`; in the
  desktop window, read the `diagnostics` field of the request. Prefix the
  line with `[developer]` and write it so a person can read it without the
  code. Log names, statuses and counts, never cookie values, credentials,
  searches or post contents.

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

### Merging the base branch

- Resolve a conflict hunk by hunk. Never take a whole file with
  `git checkout --theirs` or `--ours`: it also discards the changes of that side
  that did not conflict.
- Before pushing a merge, audit what your branch lost. For each file your branch
  changed, check that its changes are still there:
  `for f in $(git diff --name-only BASE TIP); do git diff BASE TIP -- $f | git apply -R --check 2>/dev/null || echo "partial: $f"; done`
  (`BASE` is the commit your branch started from, `TIP` its last commit before
  the merge). Read every file it lists line by line.
- Compilers and unit tests do not notice a dropped style rule or a dropped
  guard. Say in the PR which files you audited.

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
- Commit documentation-only changes (`.md` files) directly to `main` and
  push. Do not open a PR. A change that also touches code, configuration, or
  workflows follows the PR flow.

### Issue and PR size

Every issue and PR carries a fixed cost: CI, review, merge. These rules keep
issues and PRs from being smaller than that cost.

- The scope of a piece of work is the user flow you are working on, not the
  issue text. Fixing a defect in that flow does not widen the scope.
- An issue describes an outcome the user can check, not a technical step.
- Work that closes in one session is one issue and one PR. Do not open
  follow-up issues for tasks that fit in the same PR.
- Fix a defect found in the flow you are working on in the same branch and
  list it under `Fixed` in the PR, even if the code comes from an earlier PR.
- Open a separate issue or PR only when the work:
  - touches a different module or flow;
  - needs a product decision that belongs to the owner;
  - changes authentication, permissions, or sessions.
- A migration goes in the feature PR, in its own commit, and is named in the
  description under `Decisions`.
- A destructive migration (`DROP`, rename, type change) ships only in a
  release after the one that ships the code that stops using the old shape.
- Do not split a PR by line count. On a diff that spans several modules, run
  the review module by module.
- Record decisions taken during the work in the PR description, under a
  `Decisions` heading.

### Pull request labels

- Label every pull request before it merges: `enhancement` when a user gains
  something new, `bug` when something that was wrong is fixed. Use
  `documentation` or no label for work users do not notice.
- Keep one user-visible outcome per pull request, together with the fixes to
  the same flow. Write its title for the user.
- Say in the description what changes for the user, under two headings:
  `New` for what a user could not do before, `Fixed` for what was wrong.
  Write each fix as the problem the user had ("Tiles moved while the gallery
  loaded"), not as the new behavior. Omit an empty heading. The release notes
  are written from the title and the description.

### Versions and releases

- All supported platforms share one `MAJOR.MINOR.PATCH` version, one
  `v<version>` tag and one GitHub Release titled `GoonCave <version>`.
- The `Weekly release` workflow builds every supported platform from the
  same commit and with the same version. Do not carry binaries from an older
  release or create platform-specific tags.
- The workflow creates the tag with the draft. Do not push release tags by
  hand or edit version numbers in source files. Keep database, sync-format
  and backup-format versions separate from the application version.
- Preserve historical platform tags and releases. The first unified version
  advances above the highest legacy platform version; later runs count from
  the previous `v<version>` tag. See [versioning](docs/versioning.md).
- Advance `MINOR` for a shipped pull request labeled `enhancement`, otherwise
  `PATCH`. Dependency-only and Markdown-only changes do not trigger a release.
  Change `MAJOR` only by explicit human decision.
- Start a release only when the owner asks, or through the owner's weekly
  scheduled agent: `gh workflow run weekly-release.yml --ref main`.
  To choose one shared version, add `-f version=1.3.0`.
- Attach `GoonCave-linux-x86_64.flatpak` and `GoonCave-iphone.ipa` built by
  that run. Package filenames omit the version. Attach no checksum
  or metadata files. Future platforms join the same version when approved.
- After the draft is ready, write `**New**` and `**Fixed**` lists; omit an
  empty list. Mention the platform only when a change is platform-specific.
  Compare the code against the previous release tag; PR text and labels are
  hints. A moved, restyled or rewritten feature is not new. A bug introduced
  and fixed between the two tags is not a fix. Describe each fix as the
  problem the user had. Use one short plain sentence per item, with no PR
  numbers or internal details. Group related changes and omit invisible work.
  `.github/scripts/release-prs.sh <previous tag> <commit>` lists shipped PRs.
- Leave every release as a draft. Only the owner publishes it.

### Milestones

- Name Rust core milestones `Core N — <scope>`, desktop milestones `Desktop — <scope>`, and iOS milestones `iOS — <scope>`.
- Leave the assignment of other users' issues to the owner unless explicitly requested.
- Give every new issue a milestone whose scope fits it. If none fits, create one.
- A milestone holds at most 10 issues, open and closed together. Do not add an issue to a full one: create a new milestone.
- Close a milestone when all its issues are closed.
- Assign at most one milestone per issue. Before closing a milestone issue, move to a linked issue with a milestone only the unfinished work that does not fit in the current PR.
- Use platform labels (`platform:desktop`, `platform:ios`, `platform:android`) for the affected distributions and domain labels for the feature.
- Track Rust core on iPhone and standalone parity as capability milestones with the [feature inventory](docs/feature-inventory.md). There is no server mode.
- Follow [the versioning policy](docs/versioning.md) and [the iOS roadmap](ios/README.md).

## 8. Tests

- When practical, start a bug fix with a regression test for the
  violated invariant. Verify that it fails for the intended reason.
  If the repository has no suitable test harness, state how the fix was
  verified instead.
- Add tests for new non-trivial behavior when a suitable test harness
  exists. Do not add tests that only restate reversible documentation or
  configuration edits.
- A fix whose effect is visual or depends on the device (a touch screen, hover,
  a breakpoint, scrolling) gets an end-to-end test that emulates that device
  and fails without the fix. A unit test of the logic does not see a CSS rule
  that undoes it.
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

- Deliver the iOS prototype `.ipa` file as soon as its dedicated build and
  artifact upload job succeeds. Download the artifact for the current PR head,
  extract the `.ipa`, and attach the file directly or save it in the user's
  Downloads folder with a clickable local file link. Do not give the user a
  GitHub artifact ZIP link. Do not overwrite an existing file. Do not wait for
  unrelated PR checks before delivering the IPA. Continue monitoring all PR
  checks separately and report their actual status without calling the PR ready
  early.
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
