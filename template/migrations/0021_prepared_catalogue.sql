-- Producer-owned catalogue receipts distinguish an actual empty owner from
-- an owner whose external catalogue has not been reconciled yet.
CREATE TABLE prepared_catalogues (
  owner TEXT PRIMARY KEY COLLATE NOCASE,
  checked_at INTEGER NOT NULL
);
CREATE TABLE prepared_repositories (
  owner TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL COLLATE NOCASE,
  id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  default_branch TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY(owner,name)
);
CREATE INDEX prepared_repository_identity ON prepared_repositories(id);
