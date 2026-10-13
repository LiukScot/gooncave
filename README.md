<div align="center">

# GoonCave

**Your favorites from every booru, in one place on your own devices.**

Local-first media library with a booru-style interface, dual-way favorites sync, and a real tag database.

<!-- screenshot: drop a gallery screenshot here -->
<!-- <img src="docs/screenshot.png" alt="GoonCave gallery view" width="800"> -->

</div>

---

## Why GoonCave

Your favorites are scattered across e621, Danbooru, Gelbooru and half a dozen other sites — each with its own account and its own tags. GoonCave pulls them onto your own disk and gives you one gallery, one search, one tag vocabulary.

## Features

### Library

- Local-first: files live on your disk, browsed through a booru-style gallery
- Duplicate check system
- Auto-tagging: a WD14 model labels your files, so even files without a source can have tags
- Parent/child posts: a file whose booru post has relatives is marked in the gallery, and the whole group shows as thumbnails in the detail view — in Explore too
- Pools: a post that belongs to a comic or a set gets a prev/next navigator in the detail view, and the pool opens as its own page-by-page view (e621 and Danbooru)

### Sync

- Add your own booru sites
- Dual-way favorites sync
- Tag fetch and source matching across every configured site
- Source finder: automatic scans via the Fluffle and SauceNAO APIs discover where your files came from
- Follow your favorite artists and get a feed composed of only their posts

### Search

- Booru syntax: `a b` requires both, `~a ~b` matches either, `-a` excludes, `score:>5` filters on votes, etc.
- Tag autocomplete from your own library as you type
- Tag database imported weekly from the public e621 export and the Danbooru API: `1girls`, `2girls` and `female` all find the same files, a broad tag also finds everything under it, and tags a site handed over uncategorised are filed under artist, character, species and the rest
- Tag blacklist (Settings → Blacklist): paste a list of tags to hide, and pick whether it applies to Explore, the gallery, or both

### Controls

- Remappable keyboard shortcuts (Settings → Shortcuts)
- Fullscreen: mouse-wheel zoom, drag to pan, double-click to reset

## Download

There is no app to download yet. GoonCave is moving to one Rust core that runs
on every device, with no server
([ADR 0004](adr/0004-flatpak-desktop-and-device-sync.md)). The first download
will be the Linux desktop app as a `.flatpak` file, once the core covers every
feature. An iPhone app follows; see the [iOS section](ios/README.md).

Devices share their library through a WebDAV folder; see [sync](docs/sync.md).
Desktop and iPhone have [independent release versions](docs/versioning.md).

## Rule34 account

In **Settings → Accounts**, use `https://api.rule34.xxx` as the Base URL,
with your Rule34 User ID and API key. The Rule34 suggestion fills this URL.
Existing accounts keep their saved Base URL.

Adding or removing remote favorites still uses `rule34.xxx` and requires
a session cookie from a browser logged in to that site. GoonCave also sends
the saved cookie when reading the favorites list. The favorites list
and tag categories come from the website, which may request a CAPTCHA
even when Explore searches through the API work.

## Development

Install [Bun](https://bun.sh/docs/installation) and
[Rust](https://www.rust-lang.org/tools/install). The repository selects its
Rust toolchain automatically. Install [FFmpeg](https://ffmpeg.org/download.html)
(`ffmpeg` and `ffprobe` on your `PATH`): the core uses it to read pictures and
videos and to make thumbnails. To build the desktop window, also install
[Tauri's Linux system dependencies](https://v2.tauri.app/start/prerequisites/).
The browser development preview needs no WebKitGTK installation.

```bash
bun install --frozen-lockfile
bun install --cwd frontend --frozen-lockfile
bun run dev
```

Open `http://127.0.0.1:4100`. This runs the Rust core and the built React
interface on the device only. It creates its own database in
`storage/core/` and reads the library from `storage/library/`; it does not
change the Bun backend's database. Put pictures and videos in
`storage/library/` to see them in the gallery. Rebuild and restart the
command after frontend changes.

To open the Tauri desktop window:

```bash
bun run desktop
```

The desktop app uses a separate database in its application data directory.
It opens without login. Its library is the `gooncave` folder inside your
Pictures folder: the gallery shows the pictures and videos you put there,
and each subfolder appears as a folder. Add tags in a file's detail view and
search with booru syntax. Tag vocabulary downloads in the background after
you add tags; its status and retry button are in Settings → Blacklist. Configure
booru sites in Settings → Accounts to browse Explore, including pools and related
posts where the site supports them. Use Sync favorites in Accounts to import
favorites from e621/e926, Danbooru, Gelbooru/Rule34 and FurAffinity. Explore can
also add and remove favorites on those sites. Settings → Subscriptions saves
searches and manages FurAffinity's watchlist. Explore → Subscribed opens the
feed where you stopped. Automatic
tagging, processing and device sync are not available yet.

The Bun backend in `backend/` and Python tagger in `tagger/` are the reference
for the Rust core. New features go into `core/`. See
[core architecture, API and verification](docs/core.md).

**Checks:**

```bash
cargo test --locked -p gooncave-core
bun run --cwd frontend test
bun run test:e2e
```

Enable the pre-commit hook with `bun run prepare`.
