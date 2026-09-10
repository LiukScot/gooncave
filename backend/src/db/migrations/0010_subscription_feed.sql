CREATE TABLE subscription_feed_items (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES user_booru_sites(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  post_json TEXT NOT NULL,
  posted_at TEXT,
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (user_id, site_id, remote_id)
);

CREATE INDEX idx_subscription_feed_user_posted
  ON subscription_feed_items(user_id, posted_at DESC, discovered_at DESC, site_id, remote_id);

CREATE TABLE subscription_feed_sync_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES user_booru_sites(id) ON DELETE CASCADE,
  next_tag_index INTEGER NOT NULL DEFAULT 0,
  feed_cursor TEXT,
  feed_exhausted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (user_id, site_id)
);
