-- isThumbPathShared runs once per deleted file (favorites cleanup, duplicate
-- resolution, rescans that rebuild a thumbnail); without this index each call
-- scans the whole files table.
CREATE INDEX IF NOT EXISTS idx_files_thumb_path ON files(thumb_path);
