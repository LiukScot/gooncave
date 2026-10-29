-- Favorites the person asked for whose local copy may not be imported yet. The row is written
-- before the site is asked and removed once the file is in the library, so an app closed in
-- between finishes the import on its next start.
CREATE TABLE pending_favorites (
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  PRIMARY KEY (user_id, site_id, remote_id)
) WITHOUT ROWID;
