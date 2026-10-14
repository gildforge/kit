-- Computed views of commits and pull requests (diffs, file sizes, commit
-- details), gzipped JSON keyed by the exact commit hashes they describe.
-- Those never change, so an entry is written once and read from then on.
CREATE TABLE IF NOT EXISTS change_cache (
  key TEXT PRIMARY KEY,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
