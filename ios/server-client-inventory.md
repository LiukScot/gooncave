# iOS 0.1.0 server-client inventory

Baseline: repository commit `838fd5b599b9ca2692d56c148ba0ba0e72783b74`.
This records the server-backed behavior to validate on iPhone. It does not claim
that any row already works in a native app. Keep this baseline fixed while the
PC product changes; reconcile later additions explicitly before release.

| Area | Existing route or source | iPhone acceptance action |
| --- | --- | --- |
| Login and account session | `frontend/src/features/auth/`, `backend/src/routes/auth.ts` | Sign in, relaunch, confirm the session persists, then sign out. |
| Gallery and file detail | `/app/gallery`, `frontend/src/features/library/`, `frontend/src/features/file-detail/` | Browse, open a file, inspect details, edit supported metadata, and return to the same place. |
| Explore and remote posts | `/app/explore`, `frontend/src/features/explore/` | Search and browse configured sites, open posts, load more without moving shown posts, and perform supported provider actions. |
| Pools and relations | `/app/pool`, `frontend/src/features/pools/` | Open a pool or related post and navigate back to the originating result. |
| Favorites and subscriptions | `frontend/src/features/favorites-accounts/`, `frontend/src/features/favorites-source/`, `frontend/src/features/explore/` | View, change, and sync favorites; browse and manage subscriptions and read marks. |
| Folders and imported files | `/app/settings/folders`, `frontend/src/features/folders/`, `backend/src/routes/files.ts` | View server folders and files, upload through the existing controls, and verify server-side operations. |
| File sources | `/app/settings/file-sources`, `frontend/src/features/favorites-source/` | Configure and use source matching and tag refresh where available. |
| Duplicates | `/app/settings/duplicates`, `frontend/src/features/duplicates/` | Inspect scans and confirm the selected resolution policy. |
| Provider accounts | `/app/settings/accounts`, `frontend/src/features/favorites-accounts/`, `backend/src/routes/booruSites.ts` | Configure sites, credentials, order, and supported capabilities for every existing engine. |
| Subscriptions | `/app/settings/subscriptions`, `frontend/src/features/settings/SubscriptionsSettings.tsx` | Edit subscription settings and verify their effect in Explore. |
| Shortcuts | `/app/settings/shortcuts`, `frontend/src/features/settings/ShortcutSettings.tsx` | Edit and use shortcuts. |
| Blacklist | `/app/settings/blacklist`, `frontend/src/features/settings/BlacklistSettings.tsx` | Edit blacklist rules and verify filtered content. |
| Extra settings | `/app/settings/extra`, `frontend/src/features/settings/ExtraSettings.tsx` | Change display and behavior preferences and verify they persist. |
| Protected media and transfers | `backend/src/routes/files.ts`, `backend/src/routes/remoteMedia.ts` | Load protected images, play and seek video, upload a file, and save a download. |
| Games tab | `/app/games`, `frontend/src/features/games/` | Show the existing placeholder; no implemented game is implied. |

The provider baseline is the nine engines registered in
`backend/src/lib/booruEngines/index.ts`: e621, Danbooru, Gelbooru, FurAffinity,
Moebooru, Philomena, Sankaku, Shimmie, and Szurubooru. Capabilities vary by
engine. Compare each configured site's actions with its server behavior rather
than assuming every engine supports every action.

The current server serves the React app and API from one origin
(`backend/src/index.ts`). The frontend defaults to that origin in production
(`frontend/src/api.ts`). Authentication uses server cookies
(`backend/src/routes/auth.ts`). A remote WebView can preserve this arrangement;
a bundled client needs a separate, validated transport contract for login,
protected media, uploads, and downloads.

Prototype evidence still required: build both candidate shells for an iPhone,
install on a physical device, test login persistence and protected media, then
record navigation, offline/startup recovery, server compatibility behavior,
minimum iOS version, and the selected bundle identity. The architecture decision
remains open until those tests pass.
