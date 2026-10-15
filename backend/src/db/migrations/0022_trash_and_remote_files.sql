-- Files deleted from the library. A file stays here for 14 days, then every device deletes it
-- for good; the row stays so that the file does not come back from another device's records.
CREATE TABLE trash (
  sha256 TEXT PRIMARY KEY,
  trashed_at TEXT NOT NULL
);
-- `files.location_type` is 'REMOTE' for a file this device knows only from sync. Records of
-- files that were already waiting are set aside (`applied = 2`): they include files deleted
-- before deletions were shared, which must not come back. One returns once the sync folder
-- stores its original.
UPDATE sync_records SET applied = 2 WHERE kind = 'file' AND applied = 0;
-- Files this device keeps even when it does not keep every original. Per device: not synced.
CREATE TABLE kept_files (
  sha256 TEXT PRIMARY KEY
);
