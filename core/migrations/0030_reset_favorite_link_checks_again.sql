-- The repair now compares the site's larger sample where there is one, which tells an edit of
-- a picture from the picture itself; files settled by the earlier comparison are checked again.
DELETE FROM favorite_link_checks;
DELETE FROM meta WHERE key = 'favorite_links.checked';
