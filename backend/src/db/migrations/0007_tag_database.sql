-- Tags arrive in two vocabularies: the WD14 tagger speaks Danbooru
-- (`1girls`, `1boy`) while the booru engines also bring e621 (`female`,
-- `male`), so the same concept splits into separate tags and a search finds
-- half the library. e621 publishes a daily alias export that maps one
-- vocabulary onto the other; it is imported here and every tag row carries
-- the tag it collapses to.

CREATE TABLE tag_aliases (
  antecedent TEXT PRIMARY KEY,
  consequent TEXT NOT NULL,
  -- 'e621' rows are replaced wholesale on every import; 'custom' rows are
  -- the user's own and survive it.
  source TEXT NOT NULL
);

-- Transitive closure, not the direct edges: search and the detail view both
-- need every ancestor of a tag, and resolving the chain per query would mean
-- a recursive query on every search.
CREATE TABLE tag_implications (
  tag TEXT NOT NULL,
  implied TEXT NOT NULL,
  PRIMARY KEY (tag, implied)
);

CREATE INDEX idx_tag_implications_implied ON tag_implications(implied);

-- A tag the user removed by hand. The row stays out of the detail view and
-- out of search until the file's tag refresh button clears it.
CREATE TABLE file_tag_suppressions (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, tag)
);

CREATE TABLE tag_db_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Filled by the import; equal to `tag` until an alias says otherwise, so a
-- library that never runs the import keeps searching exactly as before.
ALTER TABLE file_tags ADD COLUMN canonical_tag TEXT NOT NULL DEFAULT '';
UPDATE file_tags SET canonical_tag = tag;

CREATE INDEX idx_file_tags_canonical ON file_tags(canonical_tag, file_id);
