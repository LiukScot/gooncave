-- Posts the person unfavorited, so features that favorite on their own (every matched copy,
-- source matches) never add them back. A favorite made by the person removes the row.
CREATE TABLE declined_favorites (
  user_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  declined_at TEXT NOT NULL,
  PRIMARY KEY (user_id, site_id, remote_id)
) WITHOUT ROWID;
