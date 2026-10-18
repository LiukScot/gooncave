-- The post a read mark stands for, as Explore showed it, so the History list can show it again
-- without asking the site. NULL for marks saved before this column existed.
ALTER TABLE read_marks ADD COLUMN post TEXT;
CREATE INDEX idx_read_marks_history ON read_marks (scope, user_id, read_at, item_key) WHERE post IS NOT NULL;
