# Rust core development

The Cargo workspace contains `gooncave-core` in `core/` and
`gooncave-desktop` in `desktop/shell/`. The core owns SQLite and the
local HTTP API. The desktop window is Electron, in `desktop/electron/`
([ADR 0004](../adr/0004-flatpak-desktop-and-device-sync.md)). It starts
`gooncave-desktop`, the core process, which embeds the built React assets and
serves them on a loopback port. The two talk over the core's stdin and stdout;
`desktop/shell/src/main.rs` lists the messages.
Closing the window quits the app: the core stops after it uploads pending
changes to the sync folder. Quitting
waits for pending core requests to finish, with a 30-second limit. Startup failures display a native dialog
with storage and running-instance recovery guidance.

## Available behavior

The app opens the gallery without login. It shows the pictures and videos
in the library folder, with thumbnails, the file detail, votes and deletion.
You can add tags and categories to files, remove tags, and search with booru
syntax. Autocomplete uses the active library's canonical tags. Appearance
stays on the device in browser storage. Extra settings, keyboard shortcuts
and the blacklist are saved in SQLite. Explore searches the nine booru engines;
Accounts configures their addresses and device-only credentials. Favorites import and remote add/remove work for e621/e926, Danbooru,
Gelbooru/Rule34, FurAffinity and Szurubooru. Remote votes work on e621/e926,
Danbooru and Szurubooru. Subscriptions collect followed searches and
FurAffinity's watchlist in a persistent feed. File source matching uses Fluffle
and SauceNAO and refreshes tags from configured booru sites. Optional WD14
tagging runs on Linux x86-64 computers with AVX2. The gallery stacks visual
copies into one tile, and a confirmed duplicate policy resolves them. Device
sync through a WebDAV folder shares tags, votes, favorites, read marks,
sources and settings; media files are not copied yet.

The browser suite is `tests/`: `core-foundations`, `core-library` and
`gallery-scroll-restore`.

## Storage and migrations

The desktop stores its data in `app.gooncave.desktop` inside the user data
directory (`$XDG_DATA_HOME`, which the Flatpak sandbox maps to
`~/.var/app/app.gooncave.desktop/data`). The development command uses `storage/core/`.
Each contains `library.sqlite` and the `thumbnails/` cache.

The core embeds the SQL files in `core/migrations/`
at compile time. It applies missing migrations before serving requests,
inside one transaction, and verifies SHA-256 checksums on later starts.
An interrupted or failed upgrade rolls back that transaction. Add new
SQL files for schema changes; never change existing migration files.

The reference schema still has `users`, `sessions` and `user_id` foreign
keys. One internal `device-owner` row satisfies those foreign keys.
There are no login, registration or session endpoints. This row is not a
booru account and is not a synchronization identity.

## Library folder

The library is one folder: `library` inside the desktop's data directory
(`~/.var/app/app.gooncave.desktop/data/app.gooncave.desktop/library` in the
Flatpak), `storage/library/` for the development command. The core creates it
when missing and stores its path as the owner's `libraryRoot` on every start.
Earlier desktop versions kept the library in `gooncave` inside the XDG Pictures
folder. On the first start of this version, `Database::open_moving` moves those
files into the new folder and rewrites the paths in `folders`, `files` and
`favorite_items`. A rename is used when both folders are on one file system;
otherwise every file is copied, checked by size, and the old folder is deleted
only after the records point to the copies. If a copy fails, the copies are
removed and the library stays in Pictures until the next start.
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
average hash computed by FFmpeg. A file FFmpeg cannot read gets no thumbnail; it is tried
again after the app restarts or when the file changes.

## Duplicates

A scan compares files of the same media type, width and height. Each file
gets a 96×96 grayscale signature made by FFmpeg; a video gets one from three
frames spread over its length. Signatures are cached in `file_signatures`
and recomputed when the file's SHA-256 changes. Two files match when their
mean pixel difference is at most 0.5%. Copies with different dimensions are
never compared.

A confirmed policy keeps the largest file of each group, points the kept
favorites at it, removes favorites on other sites with `preferred_only`, and
deletes the other copies for good on every device, without the trash. Only
the background worker applies a policy. While the policy is on, a library
change, a finished favorites sync or a new source match queues another run.
A run interrupted by closing the app is marked failed and runs again on the
next start.

## Sync

Settings → Backup & sync connects a WebDAV folder. The folder address must use
`https://`, except on this computer or a private network address, because the
password goes with every request. The core keeps
`GoonCave/library.json.gz` there: every shared record with the time of its
last change, as described in [sync.md](sync.md). A cycle exports the shared
tables, compares them with `sync_records` (the last known state) and stamps
what changed, so writers in the core need no sync code. An SQLite update hook
marks writes to shared tables, and temporary triggers on the main connection
name the file each write touched, so a cycle compares only the records of
those files plus the small kinds that changed. The first cycle, a new active
folder, a site change or a failed stamp compares everything. The upload starts
after 5 quiet seconds. The
core reads the folder on start, after connecting and on Sync now, uploads
when it closes (the desktop shell calls `Database::upload_before_close` when its
last window closes, before shutdown blocks the main loop), writes `GoonCave/backups/<date>.json.gz` once a day and keeps
14. Writes use the file's ETag, so two devices uploading at once merge again
instead of overwriting each other. A failed cycle retries after a minute;
changes made meanwhile wait for that retry. A damaged sync file is rebuilt
from the newest readable backup and this device's records.
A remote record that cannot be applied is logged and waits; the others still
apply. A synced site that changes address or engine loses the credentials
saved on this device.

The same page downloads and imports a backup file in the snapshot format, and
takes over one account of an old GoonCave server from a copy of its database.
Both imports count as changes made now: they add and update records and never
delete. The old database is migrated in a temporary copy; only the chosen
account's folders, settings, sites, read marks and favorites are read, and
its site credentials fill sites that have none on this device. Records of
files the device lacks wait in `sync_records` and apply when the files reach
the library, with or without a connected folder.
Backup files and the folder's snapshot are read one record at a time into a
temporary table, so an import of 760,000 records stays under 100 MB. Of the
snapshot, only the records newer than this device's are then held in memory
to be saved. Waiting
records are applied 5,000 at a time, and only after the waiting records, the
files or the sites changed since the last try.

## HTTP contract

The listener binds to `127.0.0.1`. The desktop chooses an available port on
first start and saves it in the device-only `meta` table. Later starts use
that port so the browser origin, appearance and saved browsing state stay
the same. Opening the desktop app again while it runs brings its window to
the front. If another application occupies the port, startup fails with
recovery guidance; it does not silently switch origins.
The frontend and API share that origin. Host, Origin and Fetch Metadata
checks reject requests from other websites. No remote listener or CORS
allowlist is enabled.

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | `{ "status": "ok" }` |
| `GET /device` | `{ "user": profile }`; the profile has the existing owner fields and `capabilities.library`, `capabilities.boorus`, `capabilities.favorites`, `capabilities.favoritesAutoSync`, `capabilities.subscriptions`, `capabilities.processing`, `capabilities.duplicates`, `capabilities.autoFavorite`, `capabilities.tagRefresh`, `capabilities.sync`, `capabilities.browserSignIn`, true in the desktop and iPhone apps, where FurAffinity and Rule34 sign-in opens a window or a sheet, and `capabilities.openFolder`, true only in the desktop app, which opens `/open-folder?path=…` links in the file manager |
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
| `GET /files/{id}/relations` | The parent/child group of the first post the file was saved from (its favorites) that has one, looked up on the booru when the panel opens; the file's own post is marked `isCurrent` |
| `GET /files/{id}/pools`, `/source-text` | Empty response shapes while nothing in the core writes pools or source text |
| `GET /files/{id}/providers`, `POST /files/{id}/providers/{provider}` | Saved Fluffle/SauceNAO matches and serialized, cancellable image searches |
| `POST /files/{id}/tags/refresh`, `/matches/remove` | Refresh tags from trusted sources or remove an incorrect match and refresh remaining sources |
| `GET /sources`, `PUT /sources/settings`, `POST /sources/cancel` | Source visibility, automatic targets, progress and cancellation |
| `GET /files/{id}/content` | Streams only a recorded file inside its selected local folder, with HTTP byte ranges, ETag validation and stale If-Range recovery. `download=1` adds an attachment `Content-Disposition` |
| `GET /thumbnails/{name}` | A cached thumbnail referenced by a file in the active library |
| `GET /folders` | The library folder and its direct subfolders, with `status` (`IDLE` or `SCANNING`) and `lastScanAt`. `POST /folders` and `DELETE /folders/{id}` return HTTP 400 with guidance |
| `GET /library/progress` | `{ scanning, files, found, waiting }`: whether a library scan runs, files in the library, media files the latest walk found on disk, and synced or imported records still waiting for their file |
| `POST /folders/{id}/uploads` | Multipart upload, at most 500 MiB. Each file is refused when its name exists, its type is unsupported, or its bytes do not match its extension. Up to four files are processed at once; `rejected` is not in upload order |
| `POST /read-marks`, `DELETE /read-marks?scope=` | Scope `file` or `post`; 1–500 keys of 1–256 characters. For `post`, optional `posts` maps a key to the post Explore showed; the core keeps its own fields (no tags), and a copy that is not that post is left out of History |
| `GET /read-marks/history?sites=&cursor=&limit=` | Read posts that have a saved copy, newest first: `{posts, nextCursor}`; `limit` 1–100, default 40; posts of deleted sites are skipped |
| `GET /tags/suggest` | `{ suggestions: [{ tag, files }] }`; normalised `q`, `limit` 1–50 (default 10), `scope=library` or `vocabulary`. Library suggestions count active files, exclude removed tags and rank prefix matches first |
| `GET/POST /tags/database` | Import state, previous successful import time and recovery message; POST queues a background refresh |
| `GET/POST /booru-sites`, `PUT/DELETE /booru-sites/{id}` | Manage up to 32 public sites; responses expose only whether API keys and sessions are saved |
| `GET /booru-sites/engines`, `POST /booru-sites/detect` | Nine engines and suggested addresses; detect known addresses or probe public APIs |
| `POST /booru-sites/reorder`, `/booru-sites/{id}/test` | Save site order or test a read without changing remote data |
| `POST /booru-sites/{id}/sign-in` | FurAffinity only, desktop app only: opens a sign-in window and returns `sessionCookie` and `username` when the person signs in, or both `null` when the window is closed; nothing is saved until the frontend sends them to `PUT /booru-sites/{id}` |
| `POST /booru-sites/{id}/tags/refresh`, `GET /booru-sites/tags/refresh`, `POST /booru-sites/tags/refresh/cancel` | Start, read or stop a re-read of the site's posts whose stored tags have no categories; `started` or `busy` with `progress`, HTTP 404 for an unknown site |
| `GET /explore/posts` | Search selected enabled sites with `tags`, `sort` (`new`, `hot`, `popular`), `window`, UTC calendar `date`, `page` (1–1000), `limit` (1–100); errors are reported per site |
| `POST /explore/vote` | Set an up/down vote or remove the current account's vote; repeated identical requests preserve its score |
| `GET /explore/post`, `/post-tags`, `/post-text`, `/post-relations`, `/post-pools`, `/pool` | Single posts, categorized tags, descriptions, related posts and pool pages in reading order. `/post-text` returns the description as one Markdown subset (bold, italic, underline, strike, links, `\|\|spoiler\|\|`, nested `>` quotes); e621 DText is converted, Philomena Markdown is passed through |
| `GET /explore/media/{filename}` | Signed media links, same-origin images and streamed video with byte ranges; at most four transfers, 25 MiB per image or 500 MiB per video |
| `POST /explore/gallery-matches` | `posts` (at most 100: `key`, signed `matchPreviewUrl`, `width`, `height`, `fileExt`) → `keys` of posts whose picture is a library favorite. Empty unless the duplicate policy is `favorite_all`; unsigned links, GIFs, videos and failed downloads are left out |
| `POST /explore/favorite`, `/explore/unfavorite` | Change the remote favorite and save/remove its managed local copy; body contains `siteId` and `remoteId`. Media URLs are resolved from the original post. Unsupported auto-voting returns `voteError` without undoing the favorite |
| `GET /favorites/sync/status`, `POST /favorites/sync`, `/favorites/sync/cancel` | Background import, bounded pagination, progress, per-site errors and cancellation; optional `providers` selects site IDs or preset keys. `deleteMissing=true` removes only managed copies after a complete, error-free remote listing |
| `GET /credentials`, `PUT /credentials` | Device-only SauceNAO API key; reads return only whether a key is saved |
| `GET /settings/subscriptions`, `/settings/subscriptions/tags` | Saved searches; the full settings response also reads enabled FurAffinity watchlists, with per-site errors |
| `PUT/POST /settings/subscriptions/tags` | Replace searches (`tags`) or add one normalized tag (`tag`); up to 500 searches of 100 characters. PUT preserves spaces and search operators |
| `POST/DELETE /settings/subscriptions/artists` | Follow/unfollow a FurAffinity artist (`siteId`, `artist`), confirmed by rereading the remote account |
| `GET/POST/DELETE /settings/subscriptions/pools` | Followed pools of existing sites: `siteId`, `siteName`, `poolId`, `name`, `postCount`, `coverUrl`. POST/DELETE take `siteId` and `poolId`; POST reads the name, page count and first-page preview from the site (e621 and Danbooru only); up to 500 pools. Synced between devices |
| `GET /explore/subscriptions` | Cached posts in descending upload/discovery order, `sites`, opaque `cursor`, `limit` 1–100; `resume=1` starts at the saved reading bookmark |
| `POST /explore/subscriptions/refresh` | Refresh and backfill enabled sites, `rounds` 1–4; returns per-site errors |
| `PUT /explore/subscriptions/bookmark` | Save the visible feed post (`siteId`, `remoteId`) |
| `POST /duplicates/scan/start`, `GET /duplicates/scan/status`, `POST /duplicates/scan/cancel` | Background scan for visual copies; optional `mediaType`, `pixelThreshold` (0–1, default 0.0005; mean difference, and no single sample may differ by more than 10 of 255 levels), `sampleSize` (8–256), `videoFrames` (1–8), `maxComparisons` (1–100000). A running scan answers `busy` |
| `GET /duplicates/favorites/recheck` | `{running, percent}`: whether the one-time repair of favorite links is running and how many of the files it must settle are settled (0 to 100, kept in `favorite_link_checks`, so it survives a restart). The core starts it at launch until it has run to the end (recorded in `meta` as `favorite_links.checked`). For each library image linked from more than one post it downloads every post's preview and removes the links whose picture is not the file's (same test as `/explore/gallery-matches`). Only posts of the file's exact width and height are judged; others stay, and a file where no linked post matches keeps all its links. Posts a site would not show are tried again after 30 minutes; after 4 rounds the repair is recorded as done anyway. A stop part way resumes on the next launch, skipping settled files. After each round a full favorites sync starts, so posts that lost their link are downloaded again. Posts of sites read through the browser engine (FurAffinity, Gelbooru) and GIF or video posts are left alone. A picture counts as the same when its sample matches the file with no sharp difference. Migrations `0029` and `0030` clear earlier checks so the repair runs again. |
| `GET/PUT /duplicates/settings` | Saved policy; PUT accepts only `{ "enabled": false }` |
| `GET /sync/settings`, `PUT /sync/settings`, `DELETE /sync/settings` | Read, connect or disconnect the WebDAV folder: `{ url, username, hasPassword }`. `PUT` takes `{ url, username, password? }`, checks the folder before saving and keeps the saved password when `password` is left out. The password is never returned |
| `GET /backup`, `POST /backup` | Download the backup file (`application/gzip`), or import one as the multipart field `file`: `{ applied, waiting }`, where `waiting` counts records whose file this device lacks. HTTP 400 for a damaged file or one from a newer GoonCave |
| `POST /backup/old-database` | Multipart fields `username` and `file`, a copy of an old server's SQLite database. Imports that account like a backup: `{ applied, waiting }`. HTTP 400 when the file is not a GoonCave database, its version is unknown or the account is missing |
| `GET /sync/status`, `POST /sync/now` | `{ state: off\|idle\|syncing\|error, lastSyncAt, error }`; `POST /sync/now` reads the folder at once and returns HTTP 400 without a connected folder |
| `POST /duplicates/policy/preview`, `/confirm`, `/retry`, `GET /duplicates/policy/status` | Plan a policy (`favorite_all` or `preferred_only` with configured sites), confirm a preview within 15 minutes, and follow the background run. A stale preview returns HTTP 409 |
| `GET /tagging` | Device-only enable state, availability, model size, download/file progress and recovery error |
| `PUT /tagging` | `{ "enabled": true/false }`; enable the model download and backfill, or stop while keeping completed tags |

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
values are SQL parameters; malformed score terms are ignored. Imported vocabulary has a one-million-row limit per Danbooru relation
table, downloads a 256 MiB compressed limit per export, and decompressed CSV
a 1 GiB limit. An oversized or malformed source fails the refresh.

## Automatic tagging

Settings → Extra shows the 388,733,784-byte download before enabling WD14.
It is off by default. The model and vocabulary come from
`SmilingWolf/wd-v1-4-convnextv2-tagger-v2`, revision
`dbd4dbe553ee51feb3bc745b614fb762080e3912`; both sizes and SHA-256 hashes
are verified before loading. Downloads stream into temporary files and
replace cached files only after verification. Closing the app or stopping
tagging removes incomplete downloads. Finished downloads are reused.

The first Linux x86-64 build fetches Microsoft's ONNX Runtime 1.30 SDK from
its official GitHub release, checks the archive and library hashes and embeds
the library and license notices. It unpacks the bundled runtime when tagging
is enabled. No Python service or separate runtime installation is needed.
The published Rust binding uses its API-30 feature with this runtime;
ONNX Runtime 1.31 changes scores on the reference images. Building needs the
11.3 MB SDK; a user consents to the separate 388.7 MB weights in Extra.

Files are prepared with EXIF rotation and fit within 2048 pixels. WD14 resizes
them to 448×448, with horizontal-first bicubic filtering and an 8-bit
intermediate matching Pillow, then reads BGR float32 pixels. General tags
use a 0.35 threshold; the other Python categories use 0.5. Tag sorting and
the Python service's category mapping are preserved. Video tagging uses a
frame at one second, separate from image-search previews.

One model and one file run at a time. Inference runs outside the HTTP worker.
The model loads when a file waits for tags and is released after a minute
with nothing to tag, so an idle app does not hold its memory.
Stop cancels downloads immediately; in-flight CPU work finishes without
saving its result. Completed tags and results remain. An unreadable file
shows an error and does not block the remaining files; turn tagging off and
on to retry. After 100 file failures the job stops. Restarting resumes an
enabled job and skips completed files. New files enter after the library scan.

`wd14_results` stores results, including empty results, by file SHA-256 and
model revision, with a change time. Copies reuse that result without another
inference. `wd14_applied` records which local file has received it and is not
portable. Manual tags, other source tags and suppressions are preserved.
The future sync protocol transfers `wd14_results`; it never transfers the
device-only `meta` enable flag, runtime, model cache or local applied rows.
File sources lists WD14 for tag visibility and links to Extra for activation.
Automatic source targets and Target all include only booru sites.
Phone tagging remains unavailable until ADR 0004's model-size decision;
Windows and other desktop targets do not have a supported tagging runtime yet.

## Verification

```sh
cargo test --locked -p gooncave-core
cargo test --locked -p gooncave-core wd14::tests::matches_python_reference_images -- --ignored
npm --prefix frontend test -- src/api.test.ts
npm run test:e2e
npm run test:desktop
```

Core integration tests use temporary SQLite databases and loopback ports.
They verify restart persistence, migrations, validation, origin checks,
media ranges, scans, thumbnails, votes, deletion, uploads, read marks, tags,
alias search, suggestions and atomic vocabulary replacement;
they need FFmpeg. Browser tests launch the Rust core with a temporary
database and a library folder holding a picture and a video. They verify
startup, saved settings, visible recovery, and opening, voting and deleting
library files.
The separate WD14 integration test explicitly downloads the pinned model
and compares three neutral images with the Python 1.30 reference: identical
tag names/categories and score differences at most 0.001. CI runs it as part
of the Rust core gate. Pixel fixtures test Pillow bicubic compatibility
without downloading model weights.

CI also builds the desktop shell with the React assets. A successful
compilation is not a substitute for testing the native window on Linux.

`tests/fixtures/core-search-reference.json` holds the expected search results
for a synthetic library. The core integration suite reads it.

## Flatpak

`desktop/flatpak/app.gooncave.desktop.yml` is the Flatpak manifest. It builds
the core inside the GNOME 51 SDK with the Rust SDK extension, adds the Electron
release and zypak, which runs Chromium's sandbox inside Flatpak's, and sets
the sandbox permissions. The
application has network access for public tag vocabulary downloads, booru
searches and media. The HTTP listener still binds only to loopback. Its
host-filesystem access is `xdg-pictures/gooncave:create`, the library folder
of earlier versions, which the first start moves into the data directory, and
`xdg-download`, where downloads such as backup exports are saved.

CI builds the `.flatpak` file on every pull request that touches the app, and
the `Weekly release` workflow attaches it to the release
([versioning](versioning.md)). To build and install it on this computer, install
Flatpak Builder once:

```sh
flatpak install --user flathub org.flatpak.Builder
```

Then, from the repository root, close GoonCave and run:

```sh
npm --prefix frontend run build
flatpak run org.flatpak.Builder --user --install --install-deps-from=flathub --force-clean flatpak-build desktop/flatpak/app.gooncave.desktop.yml
```

The first build downloads the GNOME 51 SDK and the Rust extension, about
3 GB. `flatpak-build/` and `.flatpak-builder/` hold the build and its cache.

## Explore engines

FurAffinity provides New without tag search. Shimmie provides New; unsupported
Hot and Score options are excluded. Moebooru and Szurubooru approximate Hot with
score in the last day. Gelbooru approximates bounded score periods with an ID
range derived from measured upload times; a failed measurement produces a site
error instead of silently searching all time. Live provider checks, including
the accuracy of these approximations, remain in issue #288.

Philomena uses its Wilson score within the current and previous UTC day for
Hot, and score within the selected calendar period for Popular. Moebooru
requests tag categories together with posts in its version-2 API. Older
instances can still return their original post array with general tags.
Philomena's artist and character namespaces retain their groups; tags without
a recognized namespace remain general.

Votes need a username and API key in Accounts. A repeated up/down request sets
the same direction; the interface's second click deliberately removes that
vote. Danbooru removal looks up the authenticated account and deletes only its
vote record. e621 removal uses its explicit delete operation instead of
toggling a possibly stale vote. Szurubooru sets the desired score directly. Mutations
are never retried automatically after an interrupted response.

A Cloudflare browser check (`cf-mitigated: challenge`) or HTTP 429 means the
site did not run the request, and Cloudflare checks only some requests. Every
booru read and write is sent again after 2, 5 and 12 seconds (a 429's
`Retry-After`, up to 10 seconds, when it has one). A refusal that outlasts these
answers HTTP 502 with `code` `BOORU_CAPTCHA` or `BOORU_RATE_LIMITED` next to
`error`. Explore then sends a favorite again for about eight minutes after a
`BOORU_RATE_LIMITED`, and shows a `BOORU_CAPTCHA` at once: only a browser passes it.

The SQLite database is private to the device owner on Unix. API keys and session
cookies are never returned by the site endpoints or copied into media links.
The media signing key lives in device-only `meta`. Outbound reads validate and
pin public DNS addresses; redirects to another origin are refused. The browser
loads previews, samples and files straight from each site's CDN, except
FurAffinity's, whose Cloudflare refuses a burst of thumbnails: those go through
the core's signed `/explore/media` links. Explore also signs `colorSourceUrl`
(a page can read the pixels only of same-origin pictures) and `matchPreviewUrl`
(read by gallery matching). Media requests through the core carry the
provider's referrer without account credentials. Provider failures
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
to add or remove favorites. An add answered with a server error is sent again
after 0.5 and 1.5 seconds; the new favorite is then looked for on the first
page of the favorites list, which Rule34 can update a moment late. A removal
is confirmed by the favorites page the site answers with; the sign-in page
there means the session has ended. Neither reads the whole list. An e621 or
Danbooru add refused as a duplicate is checked with one `fav:` search.
FurAffinity needs a username and session cookie.
Szurubooru uses its token-authenticated favorites API. Other engines do not
advertise favorites support. Sites without saved account
credentials are skipped by the default import so they can still be used for browsing.

Downloads are streamed to temporary files and published only after their media
content is validated. Each download is limited to 500 MiB. Lists are read in
pages, with at most 1,000 pages per site. Repeated pages or cursors stop the
import with a recovery message. Already imported files are skipped when they
still exist; missing copies are downloaded again. FurAffinity page requests are
spaced at least one second apart. Its image hosts are not spaced: Explore loads
at most four previews at a time, retries one its CDN refuses, and lets the
webview keep every signed preview, so a grid seen before loads without asking
the booru again.

FurAffinity and Rule34 put a Cloudflare browser check in front of their pages,
which only a browser engine passes. The desktop and iPhone apps register their
browser engine with the core (Electron's on the desktop, WebKit on iPhone): requests to `www.furaffinity.net` and `rule34.xxx`
run as `fetch()` calls inside a hidden page of that site, with the saved
session cookies (`a` and `b`, or `user_id` and `pass_hash`) added to its cookie
store, and a window shows the check when Cloudflare asks the person to complete
one. FurAffinity's picture hosts (`t.`, `d.`, `a.furaffinity.net`) show the same check, so on the desktop their files are fetched the same way, from a hidden page of the file's own host, and come back to the core as base64; the iPhone app still downloads them directly. These pages are spaced at least one second apart. The hidden page loads no
pictures, fonts or other sites' scripts, except Cloudflare's check. The desktop
engine keeps its cookies in Electron's `persist:browser` session, and closes the
hidden page, with its page process, after a minute without requests or when it
moves to another site; the next request opens it again. `api.rule34.xxx`, images
and every other site still use the core's own client. Without the apps, those
pages use that client too and fail while the check is on. Accounts → Sign in to
FurAffinity or Sign in to Rule34 opens a sign-in window; the session cookie is
the manual fallback, and line breaks pasted into it are removed.

Imported files retain the post tags and original source link. Explore uses the
remote favorite state when supplied by the site, and otherwise checks the local
favorites records. File deletion removes the remote favorite first when the
site's reverse-sync setting is enabled; a refused remote action preserves the
local file. Unfavoriting removes only the managed copy, retaining shared copies
and files moved elsewhere. The removed copy is deleted for good on every
device, without the trash.

Adding or removing a favorite during sync takes precedence over a previously
read remote page. Cancel sync keeps completed imports. Closing the app cancels the import and
cleans unfinished temporary downloads. Run Sync favorites again to continue;
existing copies are skipped. The Gallery's Sync favorites button starts the
same sync as Accounts.

Sites with Automatic sync on sync while the core runs: a full sync 30 seconds
after start and then every 24 hours, and a short sync every 15 minutes. A short
sync stops at the first favorites page whose posts are all in the library, so
it costs one request per site when nothing is new. Both times follow the wall
clock, so a device that slept runs the missed sync once on wake. A run is
skipped while another favorites sync is running. The setting is still stored
as `site_auto_sync_midnight` and synced as `siteAutoSyncMidnight`. Credentials stay in the device-only database
and are never sent to media hosts. Live account checks remain separate from the
fixture tests; they require the owner's account and permission for remote writes.

## File sources

Settings → File sources selects which sites appear on local files and which
sites the scanner should find automatically. Automatic search starts only after
at least one target is selected. It sends a small PNG preview to Fluffle and,
when an API key is saved, SauceNAO. The key is never included in URLs or
diagnostics, and providers receive no local paths. Requests are serialized and
cancelled when the core closes.

Automatic search runs one search every 10 seconds and tracks each provider per
file. SauceNAO searches a file only after Fluffle has, so its quota goes to files
Fluffle could not match. Each provider retries missing targets daily for up to a
week. Files already tagged with a selected source are skipped. Manual searches remain available afterwards. When a
provider reports its request limit, automatic searches with that provider stop
and the search that hit the limit does not count. SauceNAO sends no reset time,
so the core waits 30 seconds after its 30-second limit and checks again every
hour after any other limit. A restart clears the wait.
SauceNAO matches require at least 90% similarity; Fluffle accepts exact matches
because its distance is relative to the other returned candidates. The most
confident trusted match per configured site supplies its tags. Failed searches
retain the last successful results. Removing a match removes its source tags
and refreshes remaining candidates. Manual tags and suppressed tags are preserved.

Refreshing tags keeps completed updates when another site fails and reports the
failure so it can be retried.

After a search, the best trusted match on a site with Auto-favorite source
matches on is favorited on that site. The favorite record points at the
library file, so the next favorites sync skips the download. A post already
recorded for that file is not favorited again.

A post the person unfavorited, directly or by deleting its file or through the
duplicate policy, is saved in `declined_favorites`. Neither this nor Explore's
"Favorite every matched copy" favorites it again; a favorite made by the person
removes the row. The row stays on this device and is not synced.

Accounts → Re-fetch tags reads again, one post every 1.5 seconds, each file
tagged from that site whose tags have no categories. Nothing is removed first,
and an answer without categories keeps the stored tags. A post that fails is
counted and the run continues; Stop keeps completed updates. A disabled site is refused
with HTTP 400, so it receives no requests. Tests use neutral media, fake keys and loopback
provider fixtures; they do not verify live-provider accounts or quotas.

## Subscriptions

Settings → Subscriptions stores searches on this device and mirrors each enabled
FurAffinity account's watchlist. Follow and Unfollow change that remote account;
they require a username and session cookie in Accounts. Other sites follow
artist tags through saved searches. Search operators and compound searches stay one query; simple
tags are batched with OR on e621 (up to 40) and Danbooru (up to two).
A followed pool adds the search `pool:ID` on its own site only, sent alone.
Followed pools stay on this device: each device gives a synced site its own ID.

The core refreshes on startup and every 15 minutes. These background cycles skip
sites whose pages only GoonCave's browser can load, such as FurAffinity; opening the
Subscribed feed refreshes every site. Each cycle reads the
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
