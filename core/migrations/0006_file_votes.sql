-- The per-file star toggle becomes a vote score: every 24h a file can be
-- pushed one step up (+1) or down (-1). Existing stars carry over as a
-- single upvote each. Manual gallery ordering is dropped along with the
-- sort option that was its only entry point.
CREATE TABLE file_votes (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  last_vote_at TEXT NOT NULL
);

INSERT INTO file_votes (file_id, score, last_vote_at)
SELECT file_id, 1, created_at FROM file_stars;

CREATE INDEX IF NOT EXISTS idx_file_votes_score ON file_votes(score);

DROP TABLE file_stars;
-- The legacy-metadata migration fixture never created this table, so the drop
-- has to tolerate its absence.
DROP TABLE IF EXISTS file_manual_order;
