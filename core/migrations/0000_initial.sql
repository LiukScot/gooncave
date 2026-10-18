CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  library_root TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  path TEXT NOT NULL,
  type TEXT NOT NULL,
  webdav_url TEXT,
  webdav_username TEXT,
  webdav_password TEXT,
  remote_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_scan_at TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  progress REAL NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  location_type TEXT NOT NULL,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  phash TEXT,
  media_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  thumb_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_runs (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  cached_hit INTEGER NOT NULL,
  score REAL,
  source_url TEXT,
  thumb_url TEXT,
  results TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS file_tags (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  category TEXT NOT NULL,
  source TEXT NOT NULL,
  score REAL,
  source_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (file_id, tag, source)
);

CREATE TABLE IF NOT EXISTS file_favorites (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorite_items (
  user_id TEXT,
  provider TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  source_url TEXT,
  file_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider, remote_id)
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  user_id TEXT,
  provider TEXT NOT NULL,
  username TEXT,
  api_key TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS user_booru_sites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  engine TEXT NOT NULL,
  base_url TEXT NOT NULL,
  username TEXT,
  api_key TEXT,
  is_preset INTEGER NOT NULL,
  preset_key TEXT,
  enabled INTEGER NOT NULL,
  cap_favorites INTEGER NOT NULL,
  cap_tags INTEGER NOT NULL,
  cap_source_match INTEGER NOT NULL,
  cap_search INTEGER NOT NULL,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, preset_key),
  UNIQUE (user_id, base_url)
);

CREATE TABLE IF NOT EXISTS file_manual_order (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  position REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_signatures (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  data BLOB NOT NULL,
  source_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_folders_path ON folders(path);
CREATE INDEX IF NOT EXISTS idx_folders_user_id ON folders(user_id);
CREATE INDEX IF NOT EXISTS idx_favorite_items_user_id_provider ON favorite_items(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_scans_folder_id ON scans(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_folder_id ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
CREATE INDEX IF NOT EXISTS idx_files_created_at_id ON files(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_files_mtime_id ON files(mtime DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_provider_runs_file_id ON provider_runs(file_id);
CREATE INDEX IF NOT EXISTS idx_provider_runs_file_provider_created
  ON provider_runs(file_id, provider, completed_at DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_tags_file_id ON file_tags(file_id);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag_file_id ON file_tags(tag, file_id);
CREATE INDEX IF NOT EXISTS idx_file_favorites_file_id ON file_favorites(file_id);
CREATE INDEX IF NOT EXISTS idx_file_favorites_created_at ON file_favorites(created_at);
CREATE INDEX IF NOT EXISTS idx_favorite_items_provider ON favorite_items(provider);
CREATE INDEX IF NOT EXISTS idx_favorite_items_file_path ON favorite_items(file_path);
CREATE INDEX IF NOT EXISTS idx_provider_credentials_provider ON provider_credentials(provider);
CREATE INDEX IF NOT EXISTS idx_user_booru_sites_user_sort ON user_booru_sites(user_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_user_booru_sites_user_fav ON user_booru_sites(user_id, enabled, cap_favorites);
CREATE INDEX IF NOT EXISTS idx_user_booru_sites_user_tags ON user_booru_sites(user_id, enabled, cap_tags);
CREATE INDEX IF NOT EXISTS idx_user_booru_sites_user_match ON user_booru_sites(user_id, enabled, cap_source_match);
CREATE INDEX IF NOT EXISTS idx_file_manual_order_position ON file_manual_order(position);
CREATE INDEX IF NOT EXISTS idx_file_signatures_sample_size_file_id ON file_signatures(sample_size, file_id);
CREATE INDEX IF NOT EXISTS idx_files_media_type ON files(media_type);
CREATE INDEX IF NOT EXISTS idx_provider_runs_provider_file_id ON provider_runs(provider, file_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username));
CREATE INDEX IF NOT EXISTS idx_provider_runs_provider_created_hit ON provider_runs(provider, created_at, cached_hit);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_settings_user_key ON user_settings(user_id, key);
