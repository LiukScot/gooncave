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
| Gallery stars | `frontend/src/features/file-detail/` | `POST /files/:id/star` | Give a file a star once per day and sort the gallery by stars. |
| File sources | `frontend/src/features/file-detail/` | `GET /files/:id/providers`, `POST /files/:id/providers/:provider`, `POST /files/:id/matches/remove`, `GET /files/:id/source-text` | Run SauceNAO or Fluffle on a file, see the matches, and remove a wrong match. |
| Parent/child posts and pools | `/app/pool`, `frontend/src/features/pools/` | `GET /files/:id/relations`, `GET /files/:id/pools`, `GET /explore/post-relations`, `GET /explore/post-pools`, `GET /explore/pool` | Open a related post or a pool, step through it, and return to the starting result. |
| Explore | `/app/explore`, `frontend/src/features/explore/` | `GET /explore/posts`, `GET /explore/post`, `GET /explore/post-tags`, `GET /explore/post-text`, `GET /explore/post-comments`, `POST /explore/gallery-matches` | Search configured sites, open posts, and load more without moving shown posts. Posts already in the library are marked. An open post lists its comments after its tags, on sites that publish them. A library file lists the comments of the post it was saved from (`GET /files/:id/comments`). |
| Explore actions | `frontend/src/features/explore/` | `POST /explore/vote`, `POST /explore/favorite`, `POST /explore/unfavorite` | Vote on a post and add or remove a booru favorite where the engine supports it. |
| Booru previews and cache | `frontend/src/features/explore/`, `frontend/src/features/settings/ExtraSettings.tsx` | `GET /explore/media`, `GET /cache` | Previews, post details and search pages already loaded open from the cache on this device; Settings → Extra limits its size and the entries used least recently go first. |
| Recent searches | `frontend/src/features/explore/recentSearches.ts` | `GET/PUT /settings/explore` | An empty Explore search box offers the last 20 searches, shared between devices. |
| Subscriptions feed | `/app/explore?feed=subscribed`, `frontend/src/features/explore/` | `GET /explore/subscriptions` | Browse the feed of followed artists and tags, saved on the device and synced in the background. |
| Read marks and History | `/app/explore?feed=history`, `frontend/src/features/read-marks/`, `frontend/src/features/explore/` | `POST /read-marks`, `DELETE /read-marks`, `GET /read-marks/history`, `POST /read-marks/history/remove` | Mark files and posts as read while scrolling or opening them; the Unread only filter hides them, and the History page lists the read posts and the files opened in the Gallery, newest first. History filters by site, by tag (posts read before tags were kept have none) and by period. Removing entries makes them unread again. Turning History off in Extra deletes them. |
| Multiple selection | `frontend/src/features/selection/` | Existing file, star, favorite, vote and History endpoints, one request per item except History removal | A long press on a tile, or Ctrl/Cmd/Shift-click, selects it in Gallery, Explore, Subscriptions and History; taps add or remove tiles. The bar applies one action to all of them (Gallery: give a star, add or remove tags, delete; Explore and feeds: favorite, unfavorite, vote up or down; History: remove), confirms destructive ones once, and reports failures with Retry failed. The bar sits at the bottom left, centred on the corner button; on a phone its actions scroll sideways. Escape or Cancel leaves. |
| Offline mode | `frontend/src/lib/online.ts`, `frontend/src/features/shell/OfflineChip.tsx`, `frontend/src/features/shell/OfflineNotice.tsx` | `GET /files?location=LOCAL` | Without a network the page heading says Offline and the Gallery shows only downloaded files. History marks library files that cannot open. Explore, Subscriptions and Pools show what the cache kept and open its posts; a picture never loaded says it loads on reconnecting, and a page with nothing kept asks to reconnect. |
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
| Subscriptions | `/app/settings/subscriptions`, `frontend/src/features/settings/SubscriptionsSettings.tsx` | `GET /settings/subscriptions`, `GET /settings/subscriptions/tags`, `PUT /settings/subscriptions/tags`, `POST /settings/subscriptions/tags`, `POST /settings/subscriptions/artists`, `DELETE /settings/subscriptions/artists` | One input and one list of searches, artists and pools, each marked with the logo of every site where it has results; artist names also sync with the FurAffinity watchlist; filter the list by name and site from the lens; see the change in the feed. |
| Shortcuts | `/app/settings/shortcuts`, `frontend/src/features/settings/ShortcutSettings.tsx` | `GET /settings/shortcuts`, `PUT /settings/shortcuts` | Remap a shortcut and use it. |
| Blacklist | `/app/settings/blacklist`, `frontend/src/features/settings/BlacklistSettings.tsx` | `GET /settings/blacklist`, `PUT /settings/blacklist` | Hide tags in Explore, Subscriptions, the gallery, or any of them. |
| Appearance | `/app/settings/appearance`, `frontend/src/features/settings/AppearanceSettings.tsx` | None; stored on the device | Choose mode, accent and the quick button beside each page's main corner button; the choice survives a restart. |
| Extra settings | `/app/settings/extra`, `frontend/src/features/settings/ExtraSettings.tsx` | `GET /settings/extra`, `PUT /settings/extra` | Change display preferences. |
| Report issue | `/app/settings/report`, `frontend/src/features/settings/ReportIssueSettings.tsx` | `GET /report`, `POST /report/window-error` | Read the latest log, edit it, copy it or open a prefilled GitHub issue. |
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
