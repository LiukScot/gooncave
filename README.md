<div align="center">

# GoonCave

**Your favorites from every booru, in one self-hosted place.**

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
- Multiple accounts, each with their own library root and mounted folders
- Duplicate check system
- Auto-tagging: the bundled tagger service labels your files with a WD14 model, so even files without a source can have tags
- Parent/child posts: a file whose booru post has relatives is marked in the gallery, and the whole group shows as thumbnails in the detail view — in Explore too
- Pools: a post that belongs to a comic or a set gets a prev/next navigator in the detail view, and the pool opens as its own page-by-page view (e621 and Danbooru)

### Sync

- Add your own booru sites per account
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

## Quick start

```bash
docker compose up --build
```

Open `http://localhost:4100`. The media root inside the container is `/gooncave-library`.

To mount your own folders, copy `docker-compose.override.yml.example` to `docker-compose.override.yml` and set `LOCAL_MEDIA_DIR` and `GOONCAVE_USER_ID`.

> **Write access matters.** GoonCave can only upload or sync into folders it can write to. On permission errors:
>
> ```bash
> sudo chmod -R g+rwX /path/to/your/folder
> sudo find /path/to/your/folder -type d -exec chmod g+s {} \;
> ```

## Multi-user folders

Each account gets a library root like `/gooncave-library/users/<username>-<6 digits>`, and direct child folders under it are auto-detected. Mount host folders straight into that root, in both `api` and `worker` — the worker runs background scans and favorite downloads, so it needs to see the same files:

```yaml
x-media-volumes: &media-volumes
  - /mnt/photos:/gooncave-library/users/alice-123456/photos
  - /mnt/videos:/gooncave-library/users/alice-123456/videos

services:
  api:
    volumes: *media-volumes
  worker:
    volumes: *media-volumes
```

`&media-volumes` names the list once and `*media-volumes` reuses it, so the two services cannot drift apart.

Keep in mind:

- A Docker mount only makes a folder _visible_ — mounting the same host folder into two user roots shows the same files to both accounts. That's Docker, not app-level sharing.
- Folders mounted outside a user's library root exist in the container but cannot be claimed through the app.

## Deploying to a server

The server runs prebuilt images from GHCR — no git checkout, no build toolchain:

```bash
curl -O https://raw.githubusercontent.com/LiukScot/gooncave/main/docker-compose.prod.yml
docker compose -f docker-compose.prod.yml up -d
```

Passing `-f` disables Compose's automatic pickup of `docker-compose.override.yml`, so list it explicitly to keep your host media folders mounted:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.override.yml up -d
```

Every push to `main` republishes `:latest`. Update with `docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`, or let [Watchtower](https://containrrr.dev/watchtower/) do it — the compose file already carries the labels it needs.

## Development

```bash
bun install
bun install --cwd backend
bun install --cwd frontend
bun run dev
```

- Frontend: `http://localhost:5174`
- Backend: `http://localhost:4100`

**Checks:**

```bash
bun run lint
bun run format:check
bun run test:e2e
cd backend && bun run test
cd frontend && bun run test
```

Enable the pre-commit hook with `bun run prepare`.

**Environment variables:** `MEDIA_PATH`, `AUTH_USERS_DIR_NAME`, `AUTH_COOKIE_NAME`, `ALLOWED_ORIGINS`, `LOCAL_RESCAN_INTERVAL_MINUTES`, plus:

- `ALLOW_PRIVATE_BOORU_HOSTS` — booru sites on private/local addresses (`127.0.0.1`, `192.168.x.x`, `10.x.x.x`) are blocked by default so the server can't be tricked into poking at your internal network. Set `true` only if you legitimately run your own booru at home (e.g. a self-hosted Danbooru on your NAS).
- `TAGGER_SECRET` — optional shared password between the backend and the auto-tagger. Set the same value on `api`/`worker` and `tagger` and the tagger rejects any request without the matching token — handy if you ever expose the tagger outside the private Docker network.
