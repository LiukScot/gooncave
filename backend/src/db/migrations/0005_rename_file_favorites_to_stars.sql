-- The per-file manual favorite toggle was named "favorite", which collided
-- in meaning with the unrelated booru-account favorites sync feature
-- (favorite_items / /favorites/sync). Renaming to "star" disambiguates them.
ALTER TABLE file_favorites RENAME TO file_stars;

DROP INDEX IF EXISTS idx_file_favorites_file_id;
DROP INDEX IF EXISTS idx_file_favorites_created_at;

CREATE INDEX IF NOT EXISTS idx_file_stars_file_id ON file_stars(file_id);
CREATE INDEX IF NOT EXISTS idx_file_stars_created_at ON file_stars(created_at);
