-- Whether the original was missing when the person chose to keep it. Stopping to keep such a
-- file frees it again; an original that was already here stays until the next clean-up.
ALTER TABLE kept_files ADD COLUMN downloaded INTEGER NOT NULL DEFAULT 0;
