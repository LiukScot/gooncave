-- When content was last added on purpose (an upload or a share). Content added again goes to
-- the top of the Gallery: across devices the latest of these wins over the oldest `gallery_at`.
ALTER TABLE files ADD COLUMN raised_at TEXT;
