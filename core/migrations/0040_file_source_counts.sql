-- Counting the files each site found read every tag row of the site and its file, about a
-- second on a library of 8,000 files, and the Gallery waited behind it. These indexes hold the
-- (site, file) pairs, so the counts read one entry per pair.
CREATE INDEX idx_file_tags_source_file ON file_tags(source, file_id);
CREATE INDEX idx_file_tags_found_by ON file_tags(source, file_id) WHERE source_url IS NOT NULL;
-- The first index starts with `source`, so it serves every lookup this one did.
DROP INDEX idx_file_tags_source;
