CREATE TABLE wd14_results (
  sha256 TEXT NOT NULL,
  model TEXT NOT NULL,
  results TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (sha256, model)
);

CREATE TABLE wd14_applied (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  model TEXT NOT NULL,
  FOREIGN KEY (sha256, model) REFERENCES wd14_results(sha256, model)
);
