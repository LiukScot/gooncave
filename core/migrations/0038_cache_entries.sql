-- What the core keeps of what it loaded from the sites. Each row names one file in `<data>/cache`;
-- `cache_usage` holds their total size, so checking the limit reads one row.
CREATE TABLE cache_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX cache_entries_used_at ON cache_entries (used_at);
CREATE TABLE cache_usage (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bytes INTEGER NOT NULL
);
INSERT INTO cache_usage (id, bytes) VALUES (1, 0);
CREATE TRIGGER cache_entries_added AFTER INSERT ON cache_entries BEGIN
  UPDATE cache_usage SET bytes = bytes + NEW.bytes WHERE id = 1;
END;
CREATE TRIGGER cache_entries_replaced AFTER UPDATE OF bytes ON cache_entries BEGIN
  UPDATE cache_usage SET bytes = bytes - OLD.bytes + NEW.bytes WHERE id = 1;
END;
CREATE TRIGGER cache_entries_removed AFTER DELETE ON cache_entries BEGIN
  UPDATE cache_usage SET bytes = bytes - OLD.bytes WHERE id = 1;
END;
