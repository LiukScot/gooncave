-- The Subscriptions feed, saved on this device and synced in the background (ADR 0005). Not in
-- sync or backups: each device reads it from the sites.
CREATE TABLE subscription_posts (
  site_id TEXT NOT NULL REFERENCES user_booru_sites(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  -- Seconds since 1970; never later than the post above it from the same search.
  sort_at INTEGER NOT NULL,
  post TEXT NOT NULL,
  PRIMARY KEY (site_id, remote_id)
);
CREATE INDEX subscription_posts_by_date ON subscription_posts (sort_at DESC, site_id, remote_id);

-- One row per search a site reads. `head` holds the newest post IDs read, where the next sync
-- stops; `tail` is where reading older posts carries on, and `tail_at` the date of the oldest
-- post read, NULL until the first page is read.
CREATE TABLE subscription_searches (
  site_id TEXT NOT NULL REFERENCES user_booru_sites(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  head TEXT NOT NULL DEFAULT '[]',
  tail TEXT NOT NULL DEFAULT '{}',
  tail_at INTEGER,
  done INTEGER NOT NULL DEFAULT 0,
  synced_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, query)
);

-- Which searches each site's saved posts came from; a change reads the site again.
CREATE TABLE subscription_sites (
  site_id TEXT PRIMARY KEY REFERENCES user_booru_sites(id) ON DELETE CASCADE,
  searches TEXT NOT NULL
);
