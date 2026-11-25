-- The files whose tags were last written from a full answer of their site, by tag source. The
-- tag refresh (site_tags.rs) re-reads only the files not listed here. Local to this device: a
-- missing row costs one more request to the site, never a wrong tag.
CREATE TABLE site_tag_reads (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  PRIMARY KEY (file_id, source)
);
-- Every engine but gelbooru (Rule34, Gelbooru) sends categories with its posts, so a file of
-- theirs with a categorised tag was already read in full. A gelbooru post shows its categories
-- only on its page, which the app reads since this version: those files are read once more.
INSERT OR IGNORE INTO site_tag_reads (file_id, source)
SELECT DISTINCT t.file_id, t.source FROM file_tags t
JOIN user_booru_sites s ON t.source = COALESCE(s.preset_key, s.id)
WHERE t.category <> 'general' AND s.engine <> 'gelbooru';
