-- The last known state of every record shared through the sync folder. `data` is NULL for a
-- deletion marker; `applied` is 0 while the record waits for something missing on this device
-- (usually the file it belongs to).
CREATE TABLE sync_records (
  kind TEXT NOT NULL,
  record_key TEXT NOT NULL,
  data TEXT,
  changed_at TEXT NOT NULL,
  applied INTEGER NOT NULL,
  PRIMARY KEY (kind, record_key)
);
CREATE INDEX idx_sync_records_pending ON sync_records(applied) WHERE applied = 0;
