CREATE TABLE prepared_repository_diffs (
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  head TEXT NOT NULL,
  base TEXT,
  meta TEXT,
  data TEXT NOT NULL,
  PRIMARY KEY(id,version,kind,target)
);
CREATE INDEX prepared_commit_diffs ON prepared_repository_diffs(id,kind,head);
CREATE TABLE prepared_pull_catalogues (id TEXT PRIMARY KEY,meta TEXT);
CREATE TABLE prepared_pull_heads (
  id TEXT NOT NULL,
  number INTEGER NOT NULL,
  meta TEXT,
  head_ref TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  PRIMARY KEY(id,number)
);
