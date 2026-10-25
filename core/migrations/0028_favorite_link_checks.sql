-- Files whose favorite links the repair in favorite_links.rs has settled, so a restart resumes
-- where it stopped and the progress it reports survives closing the app.
CREATE TABLE favorite_link_checks (
  file_path TEXT PRIMARY KEY
) WITHOUT ROWID;
