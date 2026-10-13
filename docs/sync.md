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
| `user_settings` | Yes, except device-only keys | `key` | None today |
| `user_booru_sites` | Site list without credentials | `preset_key`, or `base_url` for a custom site | `updated_at` |
| `tag_aliases` with source `custom` | Yes | `antecedent` | None today |

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
| Appearance (mode, style, accent) | Chosen per device; stored in the browser's local storage, not in the database. |

## Media files

- Syncing media files is an option. It is off by default.
- The folder stores each file once, named by its `sha256`.
- Before the option is turned on, the setting shows how much space the files
  need.
- With the option off, a device sees synced tags, votes and sources only for
  files it already has.

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

## Gaps in the current schema

The Rust core must close these gaps before sync can work. Each one is a
mismatch between the current tables and the rules above.

- `favorite_items` links to a file through `file_path`, a device path. The
  portable key is `provider` + `remote_id`. The link to a local file must be
  found again on each device, for example through `sha256`.
- `file_tags.source`, `favorite_items.provider` and
  `file_post_relations.source` hold a site key. For a preset site the key is
  `preset_key`, the same everywhere. For a custom site it is the random
  `user_booru_sites.id`, which differs per device. Custom sites need a key
  that matches across devices, such as their `base_url`.
- `read_marks` with scope `post` uses `<siteId>:<remoteId>`, where `siteId`
  is `user_booru_sites.id`. That id is random on every device, presets
  included. The key must use the site key or `base_url` instead.
- `user_settings` and `tag_aliases` have no change time. Both need one.
- `file_tag_suppressions` has only `created_at`. Removing a suppression
  deletes the row, so it needs a deletion marker.
- Most writes delete rows: `replaceTags` deletes and reinserts every tag of a
  source; removing a tag, a vote or a read mark deletes its row. None of these
  leave a deletion marker today.
- `provider_runs.id` is random and a file can have several runs per provider.
  Only the latest completed run per file and provider needs to sync.
- The missing-source scan skips a file that has any run for a provider,
  including a `FAILED` one. Whether a failed run on one device stops the
  others from retrying is undecided.
- `files.sha256` is not unique: two copies of the same bytes on one device
  share one hash. They become one synced record.
- `user_settings` mixes data that should sync (blacklist, shortcuts,
  subscriptions) with keys that may be device-only. Each key needs a decision.
