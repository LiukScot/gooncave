INSERT OR IGNORE INTO user_settings (user_id, key, value)
SELECT user_id,
  CASE key
    WHEN 'sauce_display' THEN 'source_display'
    WHEN 'sauce_targets' THEN 'source_targets'
    WHEN 'sauce_display_initialized' THEN 'source_display_initialized'
  END,
  value
FROM user_settings
WHERE key IN ('sauce_display', 'sauce_targets', 'sauce_display_initialized');

DELETE FROM user_settings
WHERE key IN ('sauce_display', 'sauce_targets', 'sauce_display_initialized');
