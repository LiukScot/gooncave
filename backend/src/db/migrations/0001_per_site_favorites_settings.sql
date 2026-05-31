ALTER TABLE user_booru_sites
  ADD COLUMN site_auto_sync_midnight INTEGER NOT NULL DEFAULT 1;

ALTER TABLE user_booru_sites
  ADD COLUMN site_reverse_sync_enabled INTEGER NOT NULL DEFAULT 0;

ALTER TABLE user_booru_sites
  ADD COLUMN site_auto_fav_enabled INTEGER NOT NULL DEFAULT 0;

UPDATE user_booru_sites
SET
  site_auto_sync_midnight = CASE
    WHEN (
      SELECT us.value
      FROM user_settings us
      WHERE us.user_id = user_booru_sites.user_id
        AND us.key = 'favorites_auto_sync_midnight'
      LIMIT 1
    ) = 'false' THEN 0
    ELSE 1
  END,
  site_reverse_sync_enabled = CASE
    WHEN (
      SELECT us.value
      FROM user_settings us
      WHERE us.user_id = user_booru_sites.user_id
        AND us.key = 'favorites_reverse_sync'
      LIMIT 1
    ) = 'true' THEN 1
    ELSE 0
  END,
  site_auto_fav_enabled = CASE
    WHEN (
      SELECT us.value
      FROM user_settings us
      WHERE us.user_id = user_booru_sites.user_id
        AND us.key = 'favorites_auto_fav'
      LIMIT 1
    ) = 'true' THEN 1
    ELSE 0
  END;
