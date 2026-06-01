-- Capabilities are now derived from the engine module at runtime, so the
-- per-site cap_* columns (and their indexes) are redundant. Drop the indexes
-- first: SQLite refuses DROP COLUMN while a column is referenced by an index.

DROP INDEX IF EXISTS idx_user_booru_sites_user_fav;
DROP INDEX IF EXISTS idx_user_booru_sites_user_tags;
DROP INDEX IF EXISTS idx_user_booru_sites_user_match;

ALTER TABLE user_booru_sites DROP COLUMN cap_favorites;
ALTER TABLE user_booru_sites DROP COLUMN cap_tags;
ALTER TABLE user_booru_sites DROP COLUMN cap_source_match;
ALTER TABLE user_booru_sites DROP COLUMN cap_search;
