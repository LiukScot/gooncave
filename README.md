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

GoonCave for Linux is a `.flatpak` file on the
[latest release](https://github.com/LiukScot/gooncave/releases/latest). It
needs a 64-bit Intel or AMD computer and [Flatpak](https://flatpak.org/setup/)
with Flathub, which most Linux distributions include.

1. Download `GoonCave-linux-x86_64.flatpak` from the release.
2. Open a terminal in the folder where you saved it and run
   `flatpak install --user GoonCave-linux-x86_64.flatpak`. The first install
   also downloads the GNOME 51 runtime from Flathub.
3. Open GoonCave from your applications menu, or run
   `flatpak run app.gooncave.desktop`.

To update, install the newer file the same way. Your library and settings stay.

Closing the window quits GoonCave, so syncing and tagging stop with it.

An iPhone app follows; see the [iOS section](ios/README.md). Devices share
their library through a WebDAV folder; see [sync](docs/sync.md). Desktop and
iPhone have [one release version](docs/versioning.md).

## Rule34 account

In **Settings → Accounts**, use `https://api.rule34.xxx` as the Base URL,
with your Rule34 User ID and API key. The Rule34 suggestion fills this URL.
Existing accounts keep their saved Base URL.

The User ID and API key are on rule34.xxx under My Account → Options →
API Access Credentials; tick "Generate New Key?" and save if it is empty.

Adding or removing remote favorites uses the `rule34.xxx` website, which puts a
browser check in front of its pages. In the desktop and iPhone apps, press
**Sign in to Rule34** on the site's card: GoonCave opens the site in its own
browser, which passes the check, and keeps the session. Without the apps, paste
the Cookie header of a browser logged in to `rule34.xxx` instead; the website
may then refuse it with a CAPTCHA even when Explore searches through the API work.

## Development

Install [Node.js](https://nodejs.org/) 24 and
[Rust](https://www.rust-lang.org/tools/install). The repository selects its
Rust toolchain automatically. Install [FFmpeg](https://ffmpeg.org/download.html)
(`ffmpeg` and `ffprobe` on your `PATH`): the core uses it to read pictures and
videos and to make thumbnails.
The first Linux x86-64 build downloads Microsoft's 11.3 MB ONNX Runtime
1.30 SDK and verifies its pinned SHA-256. The runtime is bundled in the app;
Python is not required. Model weights download only after tagging is enabled.

```bash
npm ci
npm ci --prefix frontend
npm run dev
```

Open `http://127.0.0.1:4100`. This runs the Rust core and the built React
interface on the device only. It creates its own database in
`storage/core/` and reads the library from `storage/library/`; put pictures and videos in
`storage/library/` to see them in the gallery. Rebuild and restart the
command after frontend changes.

To open the desktop window, install Electron once, then start it:

```bash
npm ci --prefix desktop/electron
npm run desktop
```

The desktop app uses a separate database in its application data directory.
It opens without login. Its library is the `library` folder inside the app's
data folder (`~/.var/app/app.gooncave.desktop/data/app.gooncave.desktop/library`
for the Flatpak). A library from an earlier version, in `~/Pictures/gooncave`,
moves there on the first start. The gallery shows the pictures and videos you put there,
subfolders included. Open folder in the gallery opens it in your file manager. To add a file, drag it from your file manager onto
the app window or paste it outside a text field; links and pictures dragged
within the app are not added. Add tags in a file's detail view and
search with booru syntax. Tag vocabulary downloads in the background after
you add tags; its status and retry button are in Settings → Blacklist. Configure
booru sites in Settings → Accounts to browse Explore, including pools and related
posts where the site supports them. Use Sync favorites in Accounts to import
favorites from e621/e926, Danbooru, Gelbooru/Rule34 and FurAffinity. Explore can
also add and remove favorites on those sites. Settings → Subscriptions saves
searches and manages FurAffinity's watchlist. For FurAffinity, press Sign in to
FurAffinity in Accounts and sign in in the window that opens; when FurAffinity
asks to check that you are a person, a window shows the check. Explore → Subscribed opens the
feed where you stopped. On Linux x86-64 computers with AVX2, Settings → Extra
offers automatic WD14 tagging. It is off by default and shows the 388.7 MB
model download before you enable it. It tags existing and new files; Stop
tagging keeps completed tags. Duplicate processing and device sync are not
available yet. Phone tagging awaits the model-size decision in
[ADR 0004](adr/0004-flatpak-desktop-and-device-sync.md).

New features go into `core/`. See
[core architecture, API and verification](docs/core.md).

**Checks:**

```bash
cargo test --locked -p gooncave-core
npm --prefix frontend test
npm run test:e2e
npm run test:desktop
```

`npm run test:desktop` opens the desktop window in Electron; run
`npm ci --prefix desktop/electron` once first.

Enable the pre-commit hook with `npm run prepare`.

## License

GoonCave is free software: you can redistribute it and modify it under the terms of the GNU General Public License, version 3 or, at your option, any later version. See [LICENSE](LICENSE).
