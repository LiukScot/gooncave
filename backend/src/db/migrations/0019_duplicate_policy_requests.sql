-- One pending run request per user. Written by whoever notices a change
-- (API routes, worker scans), executed by the worker alone.
CREATE TABLE IF NOT EXISTS duplicate_policy_requests (
  user_id TEXT PRIMARY KEY,
  reasons TEXT NOT NULL DEFAULT '[]',
  preview_id TEXT,
  requested_at TEXT NOT NULL
);
