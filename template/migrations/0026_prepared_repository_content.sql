-- Immutable content objects are repository-scoped. A snapshot receipt is written
-- only after its complete inventory; absent inventory is never an empty repo.
CREATE TABLE prepared_content_snapshots (
  id TEXT NOT NULL, version TEXT NOT NULL, sha TEXT NOT NULL, tree TEXT NOT NULL,
  PRIMARY KEY(id,version,sha)
);
CREATE TABLE prepared_content_entries (
  id TEXT NOT NULL, version TEXT NOT NULL, sha TEXT NOT NULL, path TEXT NOT NULL,
  parent TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, mode TEXT NOT NULL,
  object_sha TEXT NOT NULL, size INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  PRIMARY KEY(id,version,sha,path)
);
CREATE INDEX prepared_content_directory ON prepared_content_entries(id,version,sha,parent,path);
CREATE TABLE prepared_content_trees (
  id TEXT NOT NULL, version TEXT NOT NULL, sha TEXT NOT NULL, recursive INTEGER NOT NULL,
  data TEXT NOT NULL, PRIMARY KEY(id,version,sha,recursive)
);
CREATE TABLE prepared_content_blobs (
  id TEXT NOT NULL, version TEXT NOT NULL, sha TEXT NOT NULL, size INTEGER NOT NULL,
  content TEXT NOT NULL, PRIMARY KEY(id,version,sha)
);
