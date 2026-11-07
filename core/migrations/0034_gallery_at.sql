-- The Gallery's date order, the same on every device: when the content first entered the
-- library. Unlike `mtime`, which follows the file on this disk, a scan never changes it.
ALTER TABLE files ADD COLUMN gallery_at TEXT;
UPDATE files SET gallery_at = (SELECT MIN(other.mtime) FROM files other WHERE other.sha256 = files.sha256);

-- A row inserted without one takes the date of a row with the same content, else its file's.
CREATE TRIGGER files_gallery_at AFTER INSERT ON files WHEN NEW.gallery_at IS NULL
BEGIN
  UPDATE files SET gallery_at = COALESCE(
    (SELECT MIN(other.gallery_at) FROM files other WHERE other.sha256 = NEW.sha256 AND other.gallery_at IS NOT NULL),
    NEW.mtime
  ) WHERE id = NEW.id;
END;

DROP INDEX IF EXISTS idx_files_mtime_id;
CREATE INDEX idx_files_gallery_at ON files(gallery_at DESC, sha256 DESC, id DESC);
