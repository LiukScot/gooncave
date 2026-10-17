CREATE UNIQUE INDEX IF NOT EXISTS idx_duplicate_policy_runs_active_user
  ON duplicate_policy_runs(user_id)
  WHERE kind = 'apply' AND status = 'running';
