-- A known site added by hand was saved without its preset key, so its favorites were stored
-- under the site's own id and the favorites sync downloaded the ones saved under the preset key
-- again. Sites that now have a preset key take back their favorites; a favorite stored under
-- both keys keeps the preset one, pointing at whichever copy is in the library.
UPDATE favorite_items SET file_path = (SELECT b.file_path FROM favorite_items b
    JOIN user_booru_sites s ON s.id = b.provider AND s.user_id = b.user_id
    WHERE s.preset_key = favorite_items.provider AND b.user_id = favorite_items.user_id
      AND b.remote_id = favorite_items.remote_id AND b.file_path IN (SELECT path FROM files))
WHERE file_path NOT IN (SELECT path FROM files) AND EXISTS (SELECT 1 FROM favorite_items b
    JOIN user_booru_sites s ON s.id = b.provider AND s.user_id = b.user_id
    WHERE s.preset_key = favorite_items.provider AND b.user_id = favorite_items.user_id
      AND b.remote_id = favorite_items.remote_id AND b.file_path IN (SELECT path FROM files));
DELETE FROM favorite_items WHERE EXISTS (SELECT 1 FROM user_booru_sites s
    WHERE s.id = favorite_items.provider AND s.user_id = favorite_items.user_id AND s.preset_key IS NOT NULL
      AND EXISTS (SELECT 1 FROM favorite_items k WHERE k.user_id = favorite_items.user_id
        AND k.provider = s.preset_key AND k.remote_id = favorite_items.remote_id));
UPDATE favorite_items SET provider = (SELECT s.preset_key FROM user_booru_sites s
    WHERE s.id = favorite_items.provider AND s.user_id = favorite_items.user_id)
WHERE EXISTS (SELECT 1 FROM user_booru_sites s
    WHERE s.id = favorite_items.provider AND s.user_id = favorite_items.user_id AND s.preset_key IS NOT NULL);
