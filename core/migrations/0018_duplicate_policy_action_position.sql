ALTER TABLE duplicate_policy_actions
  ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

UPDATE duplicate_policy_actions AS action
SET position = (
  SELECT COUNT(*) - 1
  FROM duplicate_policy_actions AS preceding
  WHERE preceding.run_id = action.run_id
    AND preceding.rowid <= action.rowid
);

