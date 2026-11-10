-- Originals the sync folder held at this device's last listing, by SHA-256. A file's records
-- leave the device only once another device can get its original, so a file that is not synced
-- leaves no trace in the folder. Per device: not synced.
CREATE TABLE sync_folder_originals (
  sha256 TEXT PRIMARY KEY
);
