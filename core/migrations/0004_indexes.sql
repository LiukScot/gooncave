CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);
CREATE INDEX IF NOT EXISTS idx_files_folder_id_created_at ON files(folder_id, created_at DESC);
