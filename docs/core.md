# Rust core development

The Cargo workspace contains `gooncave-core` in `core/` and
`gooncave-desktop` in `desktop/src-tauri/`. The core owns SQLite and the
local HTTP API. Tauri embeds the built React assets and runs the core in
the same process. Closing the desktop app waits for pending core requests
to finish, with a 30-second limit. Startup failures display a native dialog
with storage and running-instance recovery guidance.

## Available behavior

The app opens the gallery without login. It shows the pictures and videos
in the library folder, with thumbnails, the file detail, votes and deletion.
Appearance stays on the device in browser storage. Extra settings, keyboard
shortcuts and the blacklist are saved in SQLite. Tag search, boorus,
processing and device sync are not available yet. Their screens explain
the limitation and link to the available settings.

`backend/`, `tagger/` and the older server scenarios in `tests/` are
reference sources. The active browser suite is `tests/core-foundations.spec.ts`.
Port the reference scenarios as their features become available; do not
count this foundation suite as complete feature parity.

## Storage and migrations

The desktop uses Tauri's application data directory for
`app.gooncave.desktop`. The development command uses `storage/core/`.
Each contains `library.sqlite` and the `thumbnails/` cache. The Bun backend
database is not read, imported or changed.

The core embeds the existing SQL files in `backend/src/db/migrations/`
at compile time. It applies missing migrations before serving requests,
inside one transaction, and verifies SHA-256 checksums on later starts.
An interrupted or failed upgrade rolls back that transaction. Add new
SQL files for schema changes; never change existing migration files.

The reference schema still has `users`, `sessions` and `user_id` foreign
keys. One internal `device-owner` row satisfies those foreign keys.
There are no login, registration or session endpoints. This row is not a
booru account and is not a synchronization identity.

## Library folder

The library is one folder: `gooncave` inside the XDG Pictures folder on the
desktop, `storage/library/` for the development command. The core creates it
when missing and stores its path as the owner's `libraryRoot` on every start.
The folder itself is the "Main library" folder row; each direct subfolder is
another folder row. A subfolder removed or renamed on disk loses its row and
its file rows on the next scan. There is no endpoint to add or remove
folders: create or delete a subfolder in the file manager.

The gallery reads files added to the library folder on disk. Settings has
no folder-management page, and the gallery has no manual upload controls.
The interface checks completed scans every five seconds and appends newly
discovered files after the files already shown. If the core opens the same
database with another library root, the previous root's records remain
stored but cannot be browsed, opened, uploaded into or deleted through the API.

The core scans at startup and then every minute (`library::RESCAN_INTERVAL`).
A scan imports new files, re-reads files whose size or modification time
changed, and removes rows of files that are gone. Symbolic links are skipped. Files are matched by extension: images
`jpg jpeg png gif bmp webp tif tiff avif`, videos
`mp4 mov avi mkv webm wmv flv m4v`.

Media is read with `ffmpeg` and `ffprobe`, which must be on `PATH`. The GNOME
51 runtime of the Flatpak includes both. Thumbnails fit a 400-pixel box;
pictures narrower than 1:2 are cropped to 1:2 from the top, GIFs become
animated WebP with at most 120 frames, and videos use the frame at one second.
Photos are rotated by their EXIF orientation. The image hash is an 8×8
average hash computed by FFmpeg; it is not comparable with hashes stored by
the Bun backend. A file FFmpeg cannot read gets no thumbnail; it is tried
again after the app restarts or when the file changes.

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
| `GET /files` | `{ files, total }` with `folderId`, `mediaType`, `limit` (1–1000), `offset` and `sort` (`mtime_desc`, `mtime_asc`, `rated`, `random` with an optional `seed`; default newest import first). A non-empty `tags` returns HTTP 501 |
| `DELETE /files/{id}` | Deletes the file from disk, its row, read marks and an unshared thumbnail |
| `POST /files/{id}/vote` | `{ "value": 1 }` or `-1`; one vote per file every 24 hours, never below 0. A refused vote returns HTTP 409 with the current `voteScore` and `nextVoteAt` |
| `GET /files/{id}/tags`, `/relations`, `/pools`, `/source-text`, `/providers` | Empty response shapes while nothing in the core writes their tables |
| `POST /files/{id}/tags/refresh` | HTTP 501 explaining that tags need booru accounts and the tagger |
| `GET /files/{id}/content` | Streams only a recorded file inside its selected local folder, with HTTP byte ranges, ETag validation and stale If-Range recovery. `download=1` adds an attachment `Content-Disposition` |
| `GET /thumbnails/{name}` | A cached thumbnail referenced by a file in the active library |
| `GET /folders` | The library folder and its direct subfolders, with `status` (`IDLE` or `SCANNING`) and `lastScanAt`. `POST /folders` and `DELETE /folders/{id}` return HTTP 400 with guidance |
| `POST /folders/{id}/uploads` | Multipart upload, at most 500 MiB. Each file is refused when its name exists, its type is unsupported, or its bytes do not match its extension. Up to four files are processed at once; `rejected` is not in upload order |
| `POST /read-marks`, `DELETE /read-marks?scope=` | Scope `file` or `post`; 1–500 keys of 1–256 characters |
| `GET /booru-sites`, `/credentials`, `/tags/suggest` | Existing empty response shapes on an empty database; unsupported populated lists return an explicit error |

Invalid setting bodies and queries return HTTP 400. Storage failures return HTTP 500
with disk-space and permissions guidance. Features not yet implemented
return HTTP 501 instead of reporting success. Setting updates are atomic.
Saved settings are validated on read; corrupt values are reported rather
than replaced silently. Request bodies are limited to 64 KiB, except uploads.

## Verification

```sh
cargo test --locked -p gooncave-core
bun run --cwd frontend test -- src/api.test.ts
bun run test:e2e
```

Core integration tests use temporary SQLite databases and loopback ports.
They verify restart persistence, migrations, validation, origin checks,
media ranges, scans, thumbnails, votes, deletion, uploads and read marks;
they need FFmpeg. Browser tests launch the Rust core with a temporary
database and a library folder holding a picture and a video. They verify
startup, saved settings, visible recovery, and opening, voting and deleting
library files.

CI also builds the desktop shell with the React assets. A successful
compilation is not a substitute for testing the native window on Linux.

## Development Flatpak

`desktop/flatpak/metadata` defines the GNOME 51 runtime, sandbox permissions
and environment for local development bundles. The application uses its
private loopback network; it has no host-network access. Its only
host-filesystem access is `xdg-pictures/gooncave:create`, the library folder.
`GIO_USE_NETWORK_MONITOR=base` and `GIO_USE_PROXY_RESOLVER=dummy` keep WebKit's
local HTTP requests from using the host network and proxy portals, which
reject requests from this offline sandbox. This configuration does not
support remote media or a system proxy.

After `bun run build`, assemble a local bundle from the repository root:

```sh
flatpak_stage=$(mktemp -d)
flatpak_repo=$(mktemp -d)
install -Dm755 target/debug/gooncave-desktop "$flatpak_stage/files/bin/gooncave-desktop"
install -Dm644 desktop/flatpak/metadata "$flatpak_stage/metadata"
install -Dm644 desktop/flatpak/app.gooncave.desktop.desktop "$flatpak_stage/files/share/applications/app.gooncave.desktop.desktop"
install -Dm644 desktop/icons/app-icon-512.png "$flatpak_stage/files/share/icons/hicolor/512x512/apps/app.gooncave.desktop.png"
mkdir -p "$flatpak_stage/export/share"
cp -r "$flatpak_stage/files/share/applications" "$flatpak_stage/files/share/icons" "$flatpak_stage/export/share/"
flatpak build-export "$flatpak_repo" "$flatpak_stage" development
flatpak build-bundle --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo "$flatpak_repo" gooncave-development.flatpak app.gooncave.desktop development
```

Install with `flatpak install --user --reinstall gooncave-development.flatpak`.
Close an existing instance before testing the replacement. This creates a
local development artifact; release automation remains separate.
