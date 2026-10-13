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
You can add tags and categories to files, remove tags, and search with booru
syntax. Autocomplete uses the active library's canonical tags. Appearance
stays on the device in browser storage. Extra settings, keyboard shortcuts
and the blacklist are saved in SQLite. Explore searches the nine booru engines;
Accounts configures their addresses and device-only credentials. Favorites import and remote add/remove work for e621/e926, Danbooru,
Gelbooru/Rule34 and FurAffinity. Subscriptions collect followed searches and
FurAffinity's watchlist in a persistent feed. Automatic tagging, processing
and device sync are not available yet.

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
| `GET /device` | `{ "user": profile }`; the profile has the existing owner fields and `capabilities.library`, `capabilities.boorus`, `capabilities.favorites`, `capabilities.favoritesAutoSync`, `capabilities.subscriptions`, `capabilities.processing` |
| `GET/PUT /settings/extra` | Existing boolean settings and `maxGridColumns`, an integer from 0 through 12; PUT is a partial update |
| `GET/PUT /settings/shortcuts` | `{ "bindings": { "action": "key" } }`; at most 64 entries, names and keys from 1 through 32 characters |
| `GET/PUT /settings/blacklist` | `tags` (at most 500 strings, each from 1 through 100 characters), `applyToExplore`, `applyToGallery`; PUT is a partial update |
| `GET /files` | `{ files, total }` with `folderId`, `mediaType`, `limit` (1–1000), `offset` and `sort` (`mtime_desc`, `mtime_asc`, `rated`, `random` with an optional `seed`; default newest import first). `tags` supports required terms, `~` alternatives, `-` exclusions, `score:` comparisons, `parent:any` and `pool:any`; at most 60 terms and 16 KiB |
| `DELETE /files/{id}` | Deletes the file from disk, its row, read marks and an unshared thumbnail |
| `POST /files/{id}/vote` | `{ "value": 1 }` or `-1`; one vote per file every 24 hours, never below 0. A refused vote returns HTTP 409 with the current `voteScore` and `nextVoteAt` |
| `GET /files/{id}/tags` | Stored tags minus removals, derived implied tags and favorite source links |
| `POST /files/{id}/tags/manual` | Add a tag or change its manual category; normalise names and resolve aliases |
| `POST /files/{id}/tags/suppress` | Remove 1–64 canonical tag names; delete manual rows and suppress provider rows |
| `DELETE /files/{id}/tags` | Clear the file's stored tags |
| `GET /files/{id}/relations`, `/pools`, `/source-text`, `/providers` | Empty response shapes while nothing in the core writes relations, pools or provider runs |
| `POST /files/{id}/tags/refresh` | HTTP 501 explaining that tags need booru accounts and the tagger |
| `GET /files/{id}/content` | Streams only a recorded file inside its selected local folder, with HTTP byte ranges, ETag validation and stale If-Range recovery. `download=1` adds an attachment `Content-Disposition` |
| `GET /thumbnails/{name}` | A cached thumbnail referenced by a file in the active library |
| `GET /folders` | The library folder and its direct subfolders, with `status` (`IDLE` or `SCANNING`) and `lastScanAt`. `POST /folders` and `DELETE /folders/{id}` return HTTP 400 with guidance |
| `POST /folders/{id}/uploads` | Multipart upload, at most 500 MiB. Each file is refused when its name exists, its type is unsupported, or its bytes do not match its extension. Up to four files are processed at once; `rejected` is not in upload order |
| `POST /read-marks`, `DELETE /read-marks?scope=` | Scope `file` or `post`; 1–500 keys of 1–256 characters |
| `GET /tags/suggest` | `{ suggestions: [{ tag, files }] }`; normalised `q`, `limit` 1–50 (default 10), `scope=library` or `vocabulary`. Library suggestions count active files, exclude removed tags and rank prefix matches first |
| `GET/POST /tags/database` | Import state, previous successful import time and recovery message; POST queues a background refresh |
| `GET/POST /booru-sites`, `PUT/DELETE /booru-sites/{id}` | Manage up to 32 public sites; responses expose only whether API keys and sessions are saved |
| `GET /booru-sites/engines`, `POST /booru-sites/detect` | Nine engines and suggested addresses; detect known addresses or probe public APIs |
| `POST /booru-sites/reorder`, `/booru-sites/{id}/test` | Save site order or test a read without changing remote data |
| `GET /explore/posts` | Search selected enabled sites with `tags`, `sort` (`new`, `hot`, `popular`), `window`, UTC calendar `date`, `page` (1–1000), `limit` (1–100); errors are reported per site |
| `GET /explore/post`, `/post-tags`, `/post-text`, `/post-relations`, `/post-pools`, `/pool` | Single posts, categorized tags, descriptions, related posts and pool pages in reading order |
| `GET /explore/media/{filename}` | Signed media links, same-origin images and streamed video with byte ranges; at most four transfers, 25 MiB per image or 500 MiB per video |
| `POST /explore/favorite`, `/explore/unfavorite` | Change the remote favorite and save/remove its managed local copy; body contains `siteId` and `remoteId`. Media URLs are resolved from the original post. Unsupported auto-voting returns `voteError` without undoing the favorite |
| `GET /favorites/sync/status`, `POST /favorites/sync`, `/favorites/sync/cancel` | Background import, bounded pagination, progress, per-site errors and cancellation; optional `providers` selects site IDs or preset keys. `deleteMissing=true` removes only managed copies after a complete, error-free remote listing |
| `GET /credentials` | Empty response on an empty provider-credential table; populated unsupported provider lists return an explicit error |
| `GET /settings/subscriptions`, `/settings/subscriptions/tags` | Saved searches; the full settings response also reads enabled FurAffinity watchlists, with per-site errors |
| `PUT/POST /settings/subscriptions/tags` | Replace searches (`tags`) or add one normalized tag (`tag`); up to 500 searches of 100 characters. PUT preserves spaces and search operators |
| `POST/DELETE /settings/subscriptions/artists` | Follow/unfollow a FurAffinity artist (`siteId`, `artist`), confirmed by rereading the remote account |
| `GET /explore/subscriptions` | Cached posts in descending upload/discovery order, `sites`, opaque `cursor`, `limit` 1–100; `resume=1` starts at the saved reading bookmark |
| `POST /explore/subscriptions/refresh` | Refresh and backfill enabled sites, `rounds` 1–4; returns per-site errors |
| `PUT /explore/subscriptions/bookmark` | Save the visible feed post (`siteId`, `remoteId`) |

Invalid setting bodies and queries return HTTP 400. Storage failures return HTTP 500
with disk-space and permissions guidance. Features not yet implemented
return HTTP 501 instead of reporting success. Setting updates are atomic.
Saved settings are validated on read; corrupt values are reported rather
than replaced silently. Request bodies are limited to 64 KiB, except uploads.

## Tag vocabulary and search

The first tag starts the public vocabulary import in the background. Later
imports run when the saved vocabulary is at least seven days old. Settings →
Blacklist shows its state and offers a download/retry button. A failed import
retries after one hour; the button queues an earlier attempt. Closing the app
cancels downloads; an interrupted import is retried on the next start.

The core streams the e621 gzip CSV exports to temporary files, builds a
separate SQLite vocabulary, and reads Danbooru aliases and implications with
cursor pagination. e621 alias names take precedence over conflicting Danbooru
rows; existing custom aliases survive. It computes all implication ancestors,
including chains across sites. Category data comes from e621, then from
Danbooru for uncategorised provider tags the export does not know. Danbooru
receives those tag names; no media is uploaded. Manual categories are preserved.

Only a complete, validated import replaces aliases, implications and categories
in one transaction, together with canonical file tags and the import timestamp.
Network or storage failures retain the previous vocabulary. Search works on
stored tag names before the first download and works offline after it.

A search term and a stored tag resolve through the same aliases. Required terms
and alternatives use indexed tag joins; exclusions also honour implications
and suppressed tags. The frontend adds the enabled gallery blacklist as
negative terms and leaves explicitly searched blacklist terms visible. Query
values are SQL parameters; malformed score terms are ignored as in the Bun
backend. Imported vocabulary has a one-million-row limit per Danbooru relation
table, downloads a 256 MiB compressed limit per export, and decompressed CSV
a 1 GiB limit. An oversized or malformed source fails the refresh.

## Verification

```sh
cargo test --locked -p gooncave-core
bun run --cwd frontend test -- src/api.test.ts
bun run test:e2e
```

Core integration tests use temporary SQLite databases and loopback ports.
They verify restart persistence, migrations, validation, origin checks,
media ranges, scans, thumbnails, votes, deletion, uploads, read marks, tags,
alias search, suggestions and atomic vocabulary replacement;
they need FFmpeg. Browser tests launch the Rust core with a temporary
database and a library folder holding a picture and a video. They verify
startup, saved settings, visible recovery, and opening, voting and deleting
library files.

CI also builds the desktop shell with the React assets. A successful
compilation is not a substitute for testing the native window on Linux.

Search parity fixtures are generated from the Bun parser and SQL filter on a
synthetic library with `bun tests/fixtures/core-search-reference.ts`. The core
integration suite consumes those expected results without running Bun.

## Development Flatpak

`desktop/flatpak/metadata` defines the GNOME 51 runtime, sandbox permissions
and environment for local development bundles. The application has network
access for public tag vocabulary downloads and booru searches and media. The HTTP listener still binds
only to loopback. Its only
host-filesystem access is `xdg-pictures/gooncave:create`, the library folder.
`GIO_USE_NETWORK_MONITOR=base` and `GIO_USE_PROXY_RESOLVER=dummy` keep WebKit's
local HTTP requests from using the host network and proxy portals, which
are not needed for the local interface. Native vocabulary downloads use TLS
and do not use the WebKit proxy settings.

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

## Explore engines

FurAffinity provides New without tag search. Shimmie provides New; unsupported
Hot and Score options are excluded. Moebooru and Szurubooru approximate Hot with
score in the last day. Gelbooru approximates bounded score periods with an ID
range derived from measured upload times; a failed measurement produces a site
error instead of silently searching all time. Live provider checks, including
the accuracy of these approximations, remain in issue #288.

The SQLite database is private to the device owner on Unix. API keys and session
cookies are never returned by the site endpoints or copied into media links.
The media signing key lives in device-only `meta`. Outbound reads validate and
pin public DNS addresses; redirects to another origin are refused. Media requests
carry the provider's referrer without account credentials. Provider failures
include recovery guidance without echoing remote response bodies or secrets.

Engine tests use local HTTP fixtures with fake credentials; their loopback
exception is compiled only in unit tests. Run the focused checks with:

```sh
cargo test --locked -p gooncave-core --test boorus
cargo test --locked -p gooncave-core --lib booru
cargo test --locked -p gooncave-core --lib explore::tests
```

## Favorites

Accounts → Sync favorites imports files into the active library root. Gelbooru
and Rule34 need a numeric user ID and API key to import, plus a session cookie
to add or remove favorites. FurAffinity needs a username and session cookie.
Other engines do not advertise favorites support. Sites without saved account
credentials are skipped by the default import so they can still be used for browsing.

Downloads are streamed to temporary files and published only after their media
content is validated. Each download is limited to 500 MiB. Lists are read in
pages, with at most 1,000 pages per site. Repeated pages or cursors stop the
import with a recovery message. Already imported files are skipped when they
still exist; missing copies are downloaded again. FurAffinity requests are
spaced at least one second apart.

Imported files retain the post tags and original source link. Explore uses the
remote favorite state when supplied by the site, and otherwise checks the local
favorites records. File deletion removes the remote favorite first when the
site's reverse-sync setting is enabled; a refused remote action preserves the
local file. Unfavoriting removes only the managed copy, retaining shared copies
and files moved elsewhere.

Adding or removing a favorite during sync takes precedence over a previously
read remote page. Cancel sync keeps completed imports. Closing the app cancels the import and
cleans unfinished temporary downloads. Run Sync favorites again to continue;
existing copies are skipped. Daily automatic sync and automatic source matching
remain disabled in this build. Credentials stay in the device-only database
and are never sent to media hosts. Live account checks remain separate from the
fixture tests; they require the owner's account and permission for remote writes.

## Subscriptions

Settings → Subscriptions stores searches on this device and mirrors each enabled
FurAffinity account's watchlist. Follow and Unfollow change that remote account;
they require a username and session cookie in Accounts. Other sites follow
artist tags through saved searches. Search operators and compound searches stay one query; simple
tags are batched with OR on e621 (up to 40) and Danbooru (up to two).

The core refreshes on startup and every five minutes. Each cycle reads the
newest page and continues older pages, with at most four requests per site and
four sites concurrently. Explicit refresh can request up to four cycles. Progress
and indexed posts survive restart; closing the app cancels in-flight requests.
Only complete pages are committed. Changing searches invalidates late responses
and clears search-based feeds while retaining FurAffinity's indexed posts.
Changing a site's address, engine or account clears that site's feed.

The feed keeps posts for 365 days and stops search backfill at 1,000 pages with
recovery guidance. Cursors retain their sort and discovery dates when a post is
refreshed, so new discoveries do not move the posts already displayed. Read
marks and local favorite changes are applied to cached posts. Network errors
retain saved posts and appear beside the affected site.

Explore → Subscribed saves the visible or opened feed post after a short pause
and when the window closes. On the next visit, the feed starts at that bookmark.
The existing Unread only filter still applies. List restoration within an open app retains
the existing scroll position and cards.

```sh
cargo test --locked -p gooncave-core --test subscriptions
cargo test --locked -p gooncave-core --lib subscription
```

These checks use fake credentials and loopback sites. They cover saved searches,
stable cursors, bookmarks after restart, late-response invalidation, search
batching, backfill, and confirmed FurAffinity follow/unfollow. Live account
verification remains separate; the tests do not change real remote watchlists.
