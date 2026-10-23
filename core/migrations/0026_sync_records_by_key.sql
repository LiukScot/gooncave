-- Stores sync records in key order, so the snapshot and the per-file lookups read neighbouring
-- pages instead of jumping from the key index to each row.
CREATE TABLE sync_records_by_key (
  kind TEXT NOT NULL,
  record_key TEXT NOT NULL,
  data TEXT,
  changed_at TEXT NOT NULL,
  applied INTEGER NOT NULL,
  PRIMARY KEY (kind, record_key)
) WITHOUT ROWID;
INSERT INTO sync_records_by_key (kind, record_key, data, changed_at, applied)
  SELECT kind, record_key, data, changed_at, applied FROM sync_records;
DROP TABLE sync_records;
ALTER TABLE sync_records_by_key RENAME TO sync_records;
CREATE INDEX idx_sync_records_pending ON sync_records(applied) WHERE applied = 0;
