CREATE TABLE IF NOT EXISTS duplicate_policy_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  style TEXT NOT NULL,
  preferred_providers TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  total_groups INTEGER NOT NULL DEFAULT 0,
  processed_groups INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  reused INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  needs_attention INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_duplicate_policy_runs_user_created
  ON duplicate_policy_runs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS duplicate_policy_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES duplicate_policy_runs(id) ON DELETE CASCADE,
  group_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  remote_id TEXT,
  file_id TEXT,
  file_name TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_duplicate_policy_actions_run
  ON duplicate_policy_actions(run_id, group_key, created_at);
