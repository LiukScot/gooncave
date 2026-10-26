-- The first repair judged links with a stricter test than the picture comparison and settled files
-- it could not resolve; it runs again with the corrected test.
DELETE FROM favorite_link_checks;
DELETE FROM meta WHERE key = 'favorite_links.checked';
