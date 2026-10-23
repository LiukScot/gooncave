-- Fluffle calls a match "exact" even when it is far from the image, and tags were copied from
-- those posts. Remove the tags and post relations that came from a Fluffle match farther than
-- 0.05, unless a trusted match of the same file names the same post. The sources stay as search
-- results; the tags of the files that have a good match are untouched.
CREATE TEMP TABLE untrusted_matches AS
WITH results AS (
  SELECT r.file_id, r.provider,
         json_extract(j.value, '$.sourceUrl') AS url,
         json_extract(j.value, '$.score') AS score,
         json_extract(j.value, '$.distance') AS distance
  FROM provider_runs r,
       json_each(CASE WHEN json_valid(r.results) THEN r.results ELSE '[]' END) j
  WHERE r.status = 'COMPLETED'
), trusted AS (
  SELECT file_id, url FROM results
  WHERE (provider = 'FLUFFLE' AND score >= 95 AND (distance IS NULL OR distance <= 0.05))
     OR (provider = 'SAUCENAO' AND score >= 90)
)
SELECT DISTINCT file_id, url FROM results
WHERE provider = 'FLUFFLE' AND score >= 95 AND distance > 0.05 AND url IS NOT NULL
  AND (file_id, url) NOT IN (SELECT file_id, url FROM trusted);

DELETE FROM file_tags
WHERE (file_id, source_url) IN (SELECT file_id, url FROM untrusted_matches);

DELETE FROM file_post_relations
WHERE EXISTS (
  SELECT 1 FROM untrusted_matches m
  WHERE m.file_id = file_post_relations.file_id
    AND (m.url LIKE '%/' || file_post_relations.remote_id
      OR m.url LIKE '%/' || file_post_relations.remote_id || '/')
);

DROP TABLE untrusted_matches;
