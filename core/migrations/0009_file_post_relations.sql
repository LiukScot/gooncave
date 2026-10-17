-- Parent/child groups, as the booru a file came from reports them. The
-- gallery grid marks a file that belongs to one, and the grid cannot ask a
-- booru per tile: the answer has to already be here when the page renders.
--
-- Written whenever a post is read for its tags, and re-read on demand from
-- the detail view. One row per file per source, because the same picture can
-- be a child on one site and a lone post on another.
CREATE TABLE file_post_relations (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  parent_id TEXT,
  has_children INTEGER NOT NULL,
  -- Comma-joined pool ids, or NULL where the booru's listing never says
  -- (every engine but e621). An empty string is a real answer: no pools.
  pool_ids TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (file_id, source)
);

-- The grid asks for a page of files at a time: "does any of these have
-- relatives" is one indexed lookup per page, not one per tile.
CREATE INDEX IF NOT EXISTS idx_file_post_relations_file ON file_post_relations(file_id);
