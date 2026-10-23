# Feature inventory

This is the list of features the Rust core must cover on every platform:
desktop and iPhone. A platform reaches parity when every row works on it.
The decision behind the core is
[ADR 0004](../adr/0004-flatpak-desktop-and-device-sync.md).

The source is the React routes in `frontend/src/router.tsx` and the core's
HTTP routes in `core/src/`. A feature added to the product after this list must be added
here in the same change.

## Screens

| Area | Frontend route and code | Backend routes | Acceptance check |
| --- | --- | --- | --- |
| Gallery and file detail | `/app/gallery`, `frontend/src/features/library/`, `frontend/src/features/file-detail/` | `GET /files`, `GET /files/:id/content`, `DELETE /files/:id` | Browse, open a file, inspect details, delete a file, and return to the same place. |
| Thumbnails | `frontend/src/features/library/` | `GET /thumbnails/*` | Every image and video in the library shows a thumbnail in the grid. |
| File tags | `frontend/src/features/file-detail/` | `GET /files/:id/tags`, `DELETE /files/:id/tags`, `POST /files/:id/tags/manual`, `POST /files/:id/tags/suppress`, `POST /files/:id/tags/refresh`, `GET /files/:id/tags/refresh/:jobId` | Add and remove a tag by hand, refresh tags from the boorus, and see the result. |
| File votes | `frontend/src/features/file-detail/` | `POST /files/:id/vote` | Vote a file up or down once per day and sort the gallery by score. |
| File sources | `frontend/src/features/file-detail/` | `GET /files/:id/providers`, `POST /files/:id/providers/:provider`, `POST /files/:id/matches/remove`, `GET /files/:id/source-text` | Run SauceNAO or Fluffle on a file, see the matches, and remove a wrong match. |
| Parent/child posts and pools | `/app/pool`, `frontend/src/features/pools/` | `GET /files/:id/relations`, `GET /files/:id/pools`, `GET /explore/post-relations`, `GET /explore/post-pools`, `GET /explore/pool` | Open a related post or a pool, step through it, and return to the starting result. |
| Explore | `/app/explore`, `frontend/src/features/explore/` | `GET /explore/posts`, `GET /explore/post`, `GET /explore/post-tags`, `GET /explore/post-text`, `POST /explore/gallery-matches` | Search configured sites, open posts, and load more without moving shown posts. Posts already in the library are marked. |
| Explore actions | `frontend/src/features/explore/` | `POST /explore/vote`, `POST /explore/favorite`, `POST /explore/unfavorite` | Vote on a post and add or remove a booru favorite where the engine supports it. |
| Booru previews | `frontend/src/features/explore/` | `GET /explore/media` | Explore previews load through the local cache; old previews are removed. |
| Subscriptions feed | `frontend/src/features/explore/` | `GET /explore/subscriptions`, `POST /explore/subscriptions/refresh` | Browse the feed of followed artists and tags, and refresh it. |
| Read marks and History | `frontend/src/features/read-marks/`, `frontend/src/features/explore/` | `POST /read-marks`, `DELETE /read-marks`, `GET /read-marks/history` | Mark files and posts as read while scrolling or opening them; the Unread only filter hides them, and Explore → History lists the read posts newest first. Turning History off in Extra deletes them. |
| Tag search and autocomplete | `frontend/src/features/library/` | `GET /tags/suggest` | Search with booru syntax (`a b`, `~a ~b`, `-a`, `score:>5`) and get suggestions from the library's tags. |
| Games tab | `/app/games`, `frontend/src/features/games/` | None | Show the existing placeholder; no game is implemented. |

## Settings

| Area | Frontend route and code | Backend routes | Acceptance check |
| --- | --- | --- | --- |
| Booru accounts | `/app/settings/accounts`, `frontend/src/features/booru-sites/`, `frontend/src/features/favorites-accounts/` | `GET /booru-sites`, `GET /booru-sites/engines`, `POST /booru-sites`, `POST /booru-sites/detect`, `PUT /booru-sites/:id`, `DELETE /booru-sites/:id`, `POST /booru-sites/:id/test`, `POST /booru-sites/reorder`, `GET /credentials`, `PUT /credentials` | Add a site, let the app detect its engine, test the credentials, reorder sites, and remove one, for every engine. |
| Favorites sync | `frontend/src/features/favorites-accounts/` | `GET /favorites/settings`, `PUT /favorites/settings`, `POST /favorites/sync`, `GET /favorites/sync/status`, `POST /favorites/sync/cancel` | Sync booru favorites both ways, follow its progress, and cancel it. |
| Tag refresh per site | `frontend/src/features/booru-sites/` | `POST /booru-sites/:id/tags/refresh`, `GET /booru-sites/tags/refresh`, `POST /booru-sites/tags/refresh/cancel` | Refresh the tags of every file from one site, follow its progress, and cancel it. |
| Library folder and imported files | `/app/gallery`, `frontend/src/features/folders/` | `GET /folders`, `POST /folders/:id/uploads` | Put files in the single library folder or its subfolders, or drop or paste them into the app, share them to GoonCave from another iPhone app, or pick them with "Add files" on iPhone, and see them in the gallery. Open the library folder from the gallery in the desktop app. |
| File sources settings | `/app/settings/file-sources`, `frontend/src/features/favorites-source/` | `GET /sources`, `PUT /sources/settings` | Choose which sources are shown and matched, and see the effect in the detail view. |
| Matching images (duplicates) | `/app/settings/duplicates`, `frontend/src/features/duplicates/` | `POST /duplicates/scan/start`, `GET /duplicates/scan/status`, `POST /duplicates/scan/cancel`, `GET /duplicates/settings`, `PUT /duplicates/settings`, `POST /duplicates/policy/preview`, `POST /duplicates/policy/confirm`, `GET /duplicates/policy/status`, `POST /duplicates/policy/retry` | Scan for matching images and videos, preview a resolution policy, confirm it, and retry failed actions. |
| Subscriptions | `/app/settings/subscriptions`, `frontend/src/features/settings/SubscriptionsSettings.tsx` | `GET /settings/subscriptions`, `GET /settings/subscriptions/tags`, `PUT /settings/subscriptions/tags`, `POST /settings/subscriptions/tags`, `POST /settings/subscriptions/artists`, `DELETE /settings/subscriptions/artists` | Follow and unfollow artists and tags, and see the change in the feed. |
| Shortcuts | `/app/settings/shortcuts`, `frontend/src/features/settings/ShortcutSettings.tsx` | `GET /settings/shortcuts`, `PUT /settings/shortcuts` | Remap a shortcut and use it. |
| Blacklist | `/app/settings/blacklist`, `frontend/src/features/settings/BlacklistSettings.tsx` | `GET /settings/blacklist`, `PUT /settings/blacklist` | Hide tags in Explore, the gallery, or both. |
| Appearance | `/app/settings/appearance`, `frontend/src/features/settings/AppearanceSettings.tsx` | None; stored on the device | Choose mode, accent and style; the choice survives a restart. |
| Extra settings and provider reports | `/app/settings/extra`, `frontend/src/features/settings/ExtraSettings.tsx`, `frontend/src/features/settings/ProviderDiagnostics.tsx` | `GET /settings/extra`, `PUT /settings/extra`, `GET /settings/provider-diagnostics` | Change display preferences; with Developer mode on, see reports of slow or failed booru requests, and the desktop app writes request diagnostics to its log. |
| Health | None | `GET /health` | The interface can tell that the core is running. |

## Background work

These jobs run in the core without a route of their own.

| Job | Acceptance check |
| --- | --- |
| Folder watcher and periodic rescan | A file added to a folder appears in the gallery without a manual scan. |
| Favorites auto-sync | Sites with automatic sync on get new favorites within 15 minutes and a full sync at start and once a day. |
| Tag database refresh | The alias, implication and category tables are imported again each week. |
| WD14 backfill | Files without WD14 tags get them. |
| Missing source scan | Files without a found source are matched with SauceNAO and Fluffle. |
| Subscription feed refresh | The feed picks up new posts from followed artists and tags. |
| Duplicate policy runs | A confirmed policy runs again when the library changes. |
| Preview cache cleanup | Old and least recently viewed booru previews are removed. |

## Booru engines

The baseline is the nine engines registered in
`core/src/booru_engines.rs`: e621, Danbooru, Gelbooru,
FurAffinity, Moebooru, Philomena, Sankaku, Shimmie and Szurubooru.
Capabilities differ by engine. Compare each site's actions in the engine
code rather than assuming every engine supports every action.

## Media

The core serves media to the interface over local HTTP. Files are not
protected by a login. Video must play and seek; ADR 0004 records that video
fails through the `tauri://` protocol on the Linux Flatpak.
