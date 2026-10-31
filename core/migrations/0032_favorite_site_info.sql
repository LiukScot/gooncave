-- What the booru said about the post a favorite came from (uploader, posting date, rating,
-- score, favorite count), as JSON. Written when the favorite is imported and refreshed by every
-- full sync, so file info never asks the site.
ALTER TABLE favorite_items ADD COLUMN site_info TEXT;
