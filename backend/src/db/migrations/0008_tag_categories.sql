-- Categories arrive per file, from whatever the booru said when the post was
-- read. A site that answers without them — the gelbooru JSON fallback, a
-- challenge page wearing a 200 — leaves every tag under 'general', and the
-- only way back was re-reading the post. e621's tags export carries the
-- category for its whole vocabulary, so the gap is filled from a table
-- instead of from one HTTP request per post.
--
-- Only non-general rows are stored: 'general' is already the default every
-- write path uses, so keeping those 157k rows would change nothing.
CREATE TABLE tag_categories (
  tag TEXT PRIMARY KEY,
  category TEXT NOT NULL
);
