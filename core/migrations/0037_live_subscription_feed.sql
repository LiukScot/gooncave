-- Subscriptions are read live from the sites: the saved feed and its sync state go.
DROP TABLE subscription_feed_items;
DROP TABLE subscription_feed_sync_state;
DELETE FROM user_settings WHERE key = 'subscriptions.feedGeneration';
