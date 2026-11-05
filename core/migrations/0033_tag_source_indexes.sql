-- Finding the tags and relations of one site (when it is adopted or removed) read every row.
CREATE INDEX idx_file_tags_source ON file_tags(source);
CREATE INDEX idx_file_post_relations_source ON file_post_relations(source);
