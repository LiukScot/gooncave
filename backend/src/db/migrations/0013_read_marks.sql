-- What the user has already been shown, so the Unread only filter can hide it
-- on the next fetch. One table serves both kinds of item: a local file is its
-- own uuid, an explore post has no row anywhere and is keyed "<siteId>:<remoteId>".
--
-- Key order is (scope, item_key, user_id), not user-first: the two hot reads
-- are "is this item read" (all three equal) and "drop this file's marks" when
-- a file is deleted (scope + item_key), and the latter would be a full scan
-- under a user-first key. Clearing one user's whole scope scans instead, which
-- is a once-per-pass action on rows it is about to delete anyway.
CREATE TABLE read_marks (
  scope    TEXT NOT NULL,
  item_key TEXT NOT NULL,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at  TEXT NOT NULL,
  PRIMARY KEY (scope, item_key, user_id)
);
