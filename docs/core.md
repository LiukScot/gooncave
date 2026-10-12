# Rust core development

The Cargo workspace contains `gooncave-core` in `core/` and
`gooncave-desktop` in `desktop/src-tauri/`. The core owns SQLite and the
local HTTP API. Tauri embeds the built React assets and runs the core in
the same process. Closing the desktop app waits for pending core requests
to finish, with a 30-second limit. Startup failures display a native dialog
with storage and running-instance recovery guidance.

## Available behavior

The app opens an empty gallery without login. Appearance stays on the
device in browser storage. Extra settings, keyboard shortcuts and the
blacklist are saved in SQLite. Folder import, library search, boorus,
processing and device sync are not available yet. Their screens explain
the limitation and link to the available settings.

`backend/`, `tagger/` and the older server scenarios in `tests/` are
reference sources. The active browser suite is `tests/core-foundations.spec.ts`.
Port the reference scenarios as their features become available; do not
count this foundation suite as complete feature parity.

## Storage and migrations

The desktop uses Tauri's application data directory for
`app.gooncave.desktop`. The development command uses `storage/core/`.
Each contains `library.sqlite`. The Bun backend database is not read,
imported or changed.

The core embeds the existing SQL files in `backend/src/db/migrations/`
at compile time. It applies missing migrations before serving requests,
inside one transaction, and verifies SHA-256 checksums on later starts.
An interrupted or failed upgrade rolls back that transaction. Add new
SQL files for schema changes; never change existing migration files.

The reference schema still has `users`, `sessions` and `user_id` foreign
keys. One internal `device-owner` row satisfies those foreign keys.
There are no login, registration or session endpoints. This row is not a
booru account and is not a synchronization identity.

## HTTP contract

The listener binds to `127.0.0.1`. The desktop chooses an available port on
first start and saves it in the device-only `meta` table. Later starts use
that port so the browser origin, appearance and saved browsing state stay
the same. If another application occupies it, startup fails with recovery
guidance; it does not silently switch origins.
The frontend and API share that origin. Host, Origin and Fetch Metadata
checks reject requests from other websites. No remote listener or CORS
allowlist is enabled.

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | `{ "status": "ok" }` |
| `GET /device` | `{ "user": profile }`; the profile has the existing owner fields and `capabilities.library`, `capabilities.boorus`, `capabilities.processing` |
| `GET/PUT /settings/extra` | Existing boolean settings and `maxGridColumns`, an integer from 0 through 12; PUT is a partial update |
| `GET/PUT /settings/shortcuts` | `{ "bindings": { "action": "key" } }`; at most 64 entries, names and keys from 1 through 32 characters |
| `GET/PUT /settings/blacklist` | `tags` (at most 500 strings, each from 1 through 100 characters), `applyToExplore`, `applyToGallery`; PUT is a partial update |
| `GET /files`, `/folders`, `/booru-sites`, `/credentials`, `/tags/suggest` | Existing empty response shapes on an empty database; unsupported populated lists return an explicit error |
| `GET /files/{id}/content` | Streams only a recorded file inside its selected local folder, with HTTP byte ranges, ETag validation and stale If-Range recovery |

Invalid setting bodies return HTTP 400. Storage failures return HTTP 500
with disk-space and permissions guidance. Features not yet implemented
return HTTP 501 instead of reporting success. Setting updates are atomic.
Saved settings are validated on read; corrupt values are reported rather
than replaced silently. Request bodies are limited to 64 KiB.

## Verification

```sh
cargo test --locked -p gooncave-core
bun run --cwd frontend test -- src/api.test.ts
bun run test:e2e
```

Core integration tests use temporary SQLite databases and loopback ports.
They verify restart persistence, migrations, validation, origin checks
and media ranges. Browser tests launch the Rust core with a temporary
database and verify startup, saved settings and visible recovery.

CI also builds the desktop shell with the React assets. A successful
compilation is not a substitute for testing the native window on Linux.
