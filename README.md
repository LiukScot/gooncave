# GoonCave

## What's GoonCave?

GoonCave is a self-hosted tool to store and sync your favorites from multiple booru sites in one place.
Features:

- local-first media library
- browse your files with a booru style interface
- add your own booru sites per account — the engine (Danbooru, e621, Moebooru, Gelbooru, Sankaku, Philomena, Shimmie2, Szurubooru) is auto-detected from the URL
- dual-way favorites sync (e621/Danbooru) and tag fetch / source matching across every configured site
- support for multiple accounts
- vote your files up or down once every 24h, and sort the gallery by score
- duplicate check system
- tag database: the public e621 alias and implication export is imported
  weekly, so `1girls`, `2girls` and `female` all find the same files, and
  searching a broad tag also finds everything under it. Add your own aliases
  under Settings → Tags.
- booru search syntax: `a b` requires both, `~a ~b` matches either, `-a`
  excludes, and `score:>5` / `score:>=5` / `score:<5` / `score:3` filter on
  the vote score
- the search box completes tags from your own library as you type
- keyboard shortcuts in the detail view (arrows, Space for fullscreen, `+`
  and `-` to vote, Canc to delete) and in dialogs (Enter confirms, Canc
  dismisses), all remappable under Settings → Shortcuts
- mouse-wheel zoom in fullscreen, drag to pan, double-click to reset

## Run the app locally

### Run With Docker

Start the stack:

```bash
docker compose up --build
```

Default URL: `http://localhost:4100`

Default media root inside the container:

```text
/gooncave-library
```

For machine-specific local mounts, copy `docker-compose.override.yml.example` to `docker-compose.override.yml` and set your own values for `LOCAL_MEDIA_DIR` and `LOCAL_USER_ID`.

### Write Access Matters

GoonCave can only upload files or sync favorites into folders it is allowed to write to.

If uploads or favorites sync fail with a permission error, give write access to the folder you mounted into GoonCave:

```bash
sudo chmod -R g+rwX /path/to/your/folder
sudo find /path/to/your/folder -type d -exec chmod g+s {} \;
```

### Multi-User Folders

Each account gets a library root like:

```text
/gooncave-library/users/<username>-<6 digits>
```

Rules:

- a Docker mount only makes a folder visible inside the container
- direct child folders under a user's library root are auto-detected by the app
- for the simplest setup, mount folders directly into the user's library root

#### One User Example

If the real host folder is:

```text
/home/luca/Nextcloud/alice-pics
```

Mount it into one user's library root in both `api` and `worker`:

```yaml
services:
  api:
    volumes:
      - /home/luca/Nextcloud/alice-pics:/gooncave-library/users/alice-123456/nextcloud

  worker:
    volumes:
      - /home/luca/Nextcloud/alice-pics:/gooncave-library/users/alice-123456/nextcloud
```

Then that user logs in and the folder appears automatically in Settings.

#### Multiple Folders

One user can have more than one mounted folder. Mount each one as a direct child of the user root so it appears automatically.

```yaml
services:
  api:
    volumes:
      - /mnt/photos:/gooncave-library/users/alice-123456/photos
      - /mnt/videos:/gooncave-library/users/alice-123456/videos

  worker:
    volumes:
      - /mnt/photos:/gooncave-library/users/alice-123456/photos
      - /mnt/videos:/gooncave-library/users/alice-123456/videos
```

#### Shared Host Folder Warning

If you mount the same real host folder into two different user roots, both accounts will see the same underlying files.

That is a Docker choice, not automatic sharing by the app.

#### What Not To Do

Do not mount folders outside the user's library root for normal multi-user usage.

```yaml
- /home/luca/Nextcloud/alice-pics:/shared/alice-pics
```

That folder exists in the container, but the user cannot claim it through the app.

## Deploying to a server

The server no longer builds anything. Every push to `main` publishes `ghcr.io/liukscot/gooncave` (api + worker) and
`ghcr.io/liukscot/gooncave-tagger` from GitHub Actions, and Watchtower on the
server pulls them and restarts the containers on its next poll.

First-time setup on the server:

```bash
curl -O https://raw.githubusercontent.com/LiukScot/gooncave/main/docker-compose.prod.yml
docker compose -f docker-compose.prod.yml up -d
```

Host media folders still come from `docker-compose.override.yml`, layered on top:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.override.yml up -d
```

A checkout is optional: keeping one means this compose file arrives with a
`git pull` instead of being copied by hand, which is worth it if the server
already pulls on a schedule.

Watchtower itself is not part of this repo, and neither is the choice of which
instance watches these containers: that is host topology, configured on the
server. This file only has to tag the images `:latest` for a poller to find
them.

Nothing else is needed after that. A nightly `git pull && docker compose up
--build` cron must not rebuild this app: that would overwrite the published
images with a local build.

To roll back, pin an image to a commit SHA in `docker-compose.prod.yml`
(`ghcr.io/liukscot/gooncave:<sha>`) and bring the stack up again. Watchtower
leaves pinned tags alone until you point them back at `:latest`.

## Development

### Run Locally

Install dependencies:

```bash
bun install
bun install --cwd backend
bun install --cwd frontend
```

Start development mode:

```bash
bun run dev
```

Default URLs:

- frontend: `http://localhost:5174`
- backend: `http://localhost:4100`

### Useful Environment Variables

- `MEDIA_PATH`
- `AUTH_USERS_DIR_NAME`
- `AUTH_COOKIE_NAME`
- `ALLOWED_ORIGINS`
- `LOCAL_RESCAN_INTERVAL_MINUTES`
- `ALLOW_PRIVATE_BOORU_HOSTS` — booru sites pointing at a private/local
  address (anything like `127.0.0.1`, `192.168.x.x`, `10.x.x.x`) are blocked
  by default. This protects the server from being tricked into poking at your
  internal network. If you legitimately run your own booru on your home
  network (e.g. a self-hosted Danbooru on your NAS), set this to `true` to
  allow it. Leave it unset (or `false`) for the safe default.
- `TAGGER_SECRET` — optional shared password between the backend and the
  auto-tagger service. Leave it empty and everything works as before. If you
  set it (the same value on both the `api`/`worker` and `tagger` containers),
  the tagger will reject any request that doesn't carry the matching token —
  handy if you ever expose the tagger outside the private Docker network.

### Tooling Commands

Common checks:

```bash
bun run lint
bun run format:check
bun run test:e2e
```

Package-level checks:

```bash
cd backend && bun run test
cd ../frontend && bun run test
```

Enable the pre-commit hook after installing dependencies:

```bash
bun run prepare
```
