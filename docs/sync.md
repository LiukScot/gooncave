# Sync between devices

Every GoonCave app can keep its library in step with the owner's other
devices through a shared folder. There is no GoonCave server. The decision is
recorded in [ADR 0004](../adr/0004-flatpak-desktop-and-device-sync.md).

## Where the data goes

- The first supported target is a WebDAV folder.
- Google Drive comes later.
- The owner chooses the folder in the app. Each device connects to the same
  folder.

## When the app syncs

- On every start, the app reads the remote copy and merges new data into its
  own database.
- After each change, the app waits a few seconds, then uploads.
- When the app closes, it uploads again.
- Once a day, the app writes a backup to the folder. The last 14 backups are
  kept; older ones are deleted.

## Backups by hand

- Settings → Backup & sync downloads a backup file with every shared record,
  and imports one.
- It also imports one account from the database of an old GoonCave server.
  Stop the server, copy `storage/data.db` (or the file named by `DATA_FILE`)
  and copy its media files into the library folder.
- An import adds and updates records; it never deletes. Its records count as
  changes made at the time of the import, so they win over older ones and
  reach the other devices at the next sync.
- Records of files the device does not have yet wait and apply when the files
  arrive.

## How records match across devices

- Each device gives a file its own random `files.id`. The same picture has a
  different `id` on every device.
- The content hash `files.sha256` is the same on every device. Synced records
  that belong to a file use `sha256` as their key.
- Records that do not belong to a file use their own natural key, listed in
  the table below.
- No synced key contains a `user_id`. A device has one owner.

## Conflicts

- The most recent change to a record wins.
- Every synced record therefore needs the time of its last change.
- A deleted record must leave a deletion marker with its time. Without the
  marker, the next merge would bring the record back from another device.

## What syncs

The table maps each table of the current database
(`backend/src/db/migrations/`) to its sync key. "File" means the row's
`file_id` is replaced by that file's `sha256`.

| Table | Synced | Key across devices | Change time |
| --- | --- | --- | --- |
| `files` | Metadata only: `sha256`, `media_type`, `size_bytes`, `width`, `height`, `duration_ms`, `phash` | `sha256` | `updated_at` |
| `file_tags` (sources `WD14`, `MANUAL` and booru sites) | Yes | File + `tag` + `source` | `updated_at` |
| `file_tag_suppressions` (tags removed by hand) | Yes | File + `tag` | `created_at` |
| `file_votes` | Yes | File | `last_vote_at` |
| `provider_runs` (found sources from SauceNAO and Fluffle) | Latest `COMPLETED` run, including runs with no match | File + `provider` | `completed_at` |
| `file_post_relations` (parent, children and pools) | Yes | File + `source` | `updated_at` |
| `read_marks`, scope `file` | Yes | File | `read_at` |
| `read_marks`, scope `post` | Yes | Site + `remote_id` | `read_at` |
| `favorite_items` (booru favorites) | Yes | `provider` + `remote_id` | `updated_at` |
| `user_settings` | Only `blacklist.settings`, `shortcuts.bindings`, `subscriptions.tags`, `source_targets`, `source_display`, `source_display_initialized` | `key` | Stamped by the sync |
| `user_booru_sites` | Name, engine, address, enabled and order; no credentials and no per-site automation switches. A site whose address or engine changes loses the credentials saved on each device | `preset_key`, or `base_url` for a custom site | Stamped by the sync |
| `tag_aliases` with source `custom` | Yes | `antecedent` | Stamped by the sync |
| `wd14_results` | Yes; a deleted result is not removed on other devices | File + `model` | Stamped by the sync |

### Never synced

| Data | Reason |
| --- | --- |
| `provider_credentials`; `username`, `api_key` and `session_cookie` in `user_booru_sites` | Booru credentials never leave the device. |
| `tag_aliases` with source `e621`, `tag_implications`, `tag_categories`, `tag_db_meta` | Each device imports them from the public tag export. |
| `folders`, `scans`, `files.path`, `files.thumb_path`, `files.folder_id` | Paths and folders exist only on one device. |
| `file_signatures` | Duplicate-check data each device computes from its own files. |
| `duplicate_policy_runs`, `duplicate_policy_actions`, `duplicate_policy_requests` | Job history on one device. |
| `subscription_feed_items`, `subscription_feed_sync_state` | A cache of booru results; each device refreshes it. |
| `users`, `sessions`, `meta` | Accounts and login are removed. |
| `user_settings` keys not listed above (grid columns, the duplicate policy, WD14, the sync connection) | Chosen per device. The duplicate policy deletes files, so each device confirms its own. |
| Appearance (mode, style, accent) | Chosen per device; stored in the browser's local storage, not in the database. |

## Media files

### In the sync folder

- Storing the original files in the folder is an option. It is off by
  default. Before it is turned on, the setting shows how much space the files
  need.
- The folder stores each original once, named by its `sha256`, and a
  thumbnail beside it.
- Turning the option off stops uploads and keeps the copies already in the
  folder.

### On each device

- Every device shows every file of the library in the Gallery, with its
  thumbnail, tags, votes and sources, whether or not the original is on the
  device.
- Each device chooses which originals it keeps:

| Level | Originals kept on the device | Default on |
| --- | --- | --- |
| Keep everything | All of them | Desktop |
| Keep only files without an account source | Files with no booru post; booru posts load from the booru when opened | iPhone |
| Keep nothing | None; every original loads when opened | |

- A file has an account source when the library knows a booru post for it: a
  favorite or a matched source. Files imported by hand and screenshots have
  none.
- An original that is not on the device loads when it is opened: from the sync
  folder, otherwise from its booru post. When neither has it, the file shows
  as unavailable and says why.
- At least one device keeps every original. A device never deletes an
  original that has no other known copy.
- Before a level change downloads or frees files, the setting shows how much
  and asks for confirmation. Lowering the level keeps existing copies until
  the owner confirms their removal.

## Heavy work is shared

- WD14 tagging and source matching run once per file, on any device.
- A device skips a file that another device has already tagged or matched.
  It learns this from synced `wd14_results` keyed by file SHA-256 and model
  revision, including a completed result with no tags, and the synced
  `provider_runs` rows. Local `wd14_applied` rows are rebuilt when applying
  a result to each local copy. The tagging enable flag and model cache stay
  on the device; importing metadata does not grant download consent.
- Desktop apps keep working from the system tray.
- Phones process only the files that are left. They work in resumable chunks
  inside iOS background tasks.

## How the core closes the schema gaps

The shared tables were not built for sync. The core keeps them unchanged and
stores the sync state beside them, in `sync_records`:

- Change times and deletion markers. Each cycle exports the shared records
  and compares them with `sync_records`. A new or changed record gets the
  current time; a record that disappeared gets a deletion marker with the
  current time. This covers tables without a change time (`user_settings`,
  `tag_aliases`) and writes that delete and reinsert rows.
- A record whose file or site this device lacks is not a deletion. It stays
  in `sync_records`, waiting, and is applied when the file arrives.
- Site keys. A custom site's random id becomes `url:<base_url>` on export and
  the local id again on import. Read marks of posts use the site key instead
  of `<siteId>`.
- Favorites carry the file's `sha256`; each device points the favorite at its
  own copy of that file.
- `provider_runs`: only the latest `COMPLETED` run per file and provider is
  shared. A `FAILED` run stays on its device, so other devices retry.
- Copies of one file on a device share one record; the oldest copy, the
  latest vote or the latest read mark speaks for them.
- A device connecting to a folder for the first time takes the folder's
  version of each shared record, then adds what only it has.
