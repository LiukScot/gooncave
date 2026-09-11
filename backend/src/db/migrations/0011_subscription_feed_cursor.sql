DROP INDEX idx_subscription_feed_user_posted;

ALTER TABLE subscription_feed_items ADD COLUMN sort_at TEXT;

UPDATE subscription_feed_items
SET sort_at = COALESCE(posted_at, discovered_at);

CREATE INDEX idx_subscription_feed_user_posted
  ON subscription_feed_items(user_id, sort_at DESC, discovered_at DESC, site_id, remote_id);
