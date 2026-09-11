ALTER TABLE subscription_feed_items ADD COLUMN favorited_override INTEGER;

ALTER TABLE subscription_feed_sync_state ADD COLUMN head_tag_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscription_feed_sync_state ADD COLUMN search_page INTEGER NOT NULL DEFAULT 2;
ALTER TABLE subscription_feed_sync_state ADD COLUMN search_page_had_posts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscription_feed_sync_state ADD COLUMN search_exhausted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscription_feed_sync_state ADD COLUMN feed_head_cursor TEXT;
