-- Optional per-site session cookie for Gelbooru-compatible engines. The
-- API-key delete endpoint redirects without proving removal (see issue #144),
-- so an authenticated browser cookie is needed for reliable reverse-delete.
-- Nullable: most engines don't use it and users may leave it unset.
ALTER TABLE user_booru_sites
  ADD COLUMN session_cookie TEXT;
