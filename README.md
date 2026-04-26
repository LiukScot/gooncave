# GoonCave

## What's GoonCave?

GoonCave is a self-hosted tool to store and sync your favorites from multiple booru sites in one place.
Features:

- local-first media library
- browse your files with a booru style interface
- dual-way favorites sync and files tagging with e621 and danbooru
- support for multiple accounts
- star your favorite files
- duplicate check system

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

## Development

### Run Locally

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

### Useful Environment Variables

- `MEDIA_PATH`
- `AUTH_USERS_DIR_NAME`
- `AUTH_COOKIE_NAME`
- `ALLOWED_ORIGINS`
- `LOCAL_RESCAN_INTERVAL_MINUTES`
