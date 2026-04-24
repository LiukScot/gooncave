# GoonCave

GoonCave is a local-first media library for scanning folders, browsing files, finding sources, syncing favorites, and tagging content.

It is currently set up for local-network use with account isolation:

- each account has its own folders, files, favorites, settings, and credentials
- each account gets its own library root under the shared media base

## Run Locally

Install dependencies:

```bash
npm install
npm install --prefix backend
npm install --prefix frontend
```

Start development mode:

```bash
npm run dev
```

Default URLs:

- frontend: `http://localhost:5174`
- backend: `http://localhost:4100`

## Run With Docker

Start the stack:

```bash
docker compose up --build
```

Services:

- `api`: backend
- `worker`: scanner/sync worker
- `tagger`: WD14 tagger

Default media root inside the container:

```text
/gooncave-library
```

Default compose mount:

```yaml
- ${MEDIA_DIR:-./gooncave-library}:/gooncave-library
```

For machine-specific local mounts, copy `docker-compose.override.yml.example` to `docker-compose.override.yml` and set your own values for `LOCAL_MEDIA_DIR` and `LOCAL_USER_ID`.

## Multi-User Folders

Each account gets a library root like:

```text
/gooncave-library/users/<username>-<6 digits>
```

Rules:

- a Docker mount only makes a folder visible inside the container
- direct child folders under a user's library root are auto-detected by the app
- for the simplest setup, mount folders directly into the user's library root

### One User Example

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

### Multiple Folders

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

### Shared Host Folder Warning

If you mount the same real host folder into two different user roots, both accounts will see the same underlying files.

That is a Docker choice, not automatic sharing by the app.

### What Not To Do

Do not mount folders outside the user's library root for normal multi-user usage.

```yaml
- /home/luca/Nextcloud/alice-pics:/shared/alice-pics
```

That folder exists in the container, but the user cannot claim it through the app.

## Useful Environment Variables

- `MEDIA_PATH`
- `AUTH_USERS_DIR_NAME`
- `AUTH_COOKIE_NAME`
- `ALLOWED_ORIGINS`
- `LOCAL_RESCAN_INTERVAL_MINUTES`
