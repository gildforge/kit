-- gild-search: code search over every repository's default branch, derived
-- from git (Artifacts). Git is the record; these rows are rebuilt from the
-- tree at the branch tip and can always be recomputed from it.

-- One row per file version. Live rows have replaced_at NULL. A push marks the
-- versions it changed or deleted as replaced; the daily cron deletes them.
CREATE TABLE search_files (
  repo_id     TEXT NOT NULL,
  repository  TEXT NOT NULL,          -- 'owner/repo' at indexing time, for display
  path        TEXT NOT NULL,
  blob_sha    TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,          -- branch tip this version was indexed from
  visibility  TEXT NOT NULL CHECK (visibility IN ('public','private')),
  language    TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL,
  indexed_at  INTEGER NOT NULL,
  replaced_at INTEGER,
  replaced_by TEXT,
  PRIMARY KEY (repo_id, path, commit_sha)
);
CREATE INDEX search_files_live ON search_files(repo_id, replaced_at);
CREATE INDEX search_files_blob ON search_files(blob_sha);
CREATE INDEX search_files_replaced ON search_files(replaced_at) WHERE replaced_at IS NOT NULL;

-- File text, once per distinct blob, with its symbols.
CREATE TABLE search_blobs (
  id       INTEGER PRIMARY KEY,
  blob_sha TEXT NOT NULL UNIQUE,
  content  TEXT NOT NULL,
  lower    TEXT NOT NULL,              -- JS toLowerCase(), what the trigram index sees
  symbols  TEXT NOT NULL DEFAULT '[]'
);
CREATE VIRTUAL TABLE search_text USING fts5(
  lower, content='search_blobs', content_rowid='id', tokenize='trigram case_sensitive 1'
);
CREATE TRIGGER search_blobs_insert AFTER INSERT ON search_blobs BEGIN
  INSERT INTO search_text(rowid, lower) VALUES (new.id, new.lower);
END;
CREATE TRIGGER search_blobs_delete AFTER DELETE ON search_blobs BEGIN
  INSERT INTO search_text(search_text, rowid, lower) VALUES ('delete', old.id, old.lower);
END;

-- Who may read each private repository: the same rule as its pages
-- (owner, owning-org members, ACL names, agents with grants).
CREATE TABLE search_access (
  repo_id   TEXT NOT NULL,
  principal TEXT NOT NULL,
  PRIMARY KEY (principal, repo_id)
);
CREATE INDEX search_access_repo ON search_access(repo_id);

-- What each repository's live rows were built from.
CREATE TABLE search_heads (
  repo_id     TEXT PRIMARY KEY,
  repository  TEXT NOT NULL,
  owner_kind  TEXT NOT NULL,
  branch      TEXT NOT NULL,
  commit_sha  TEXT NOT NULL,
  access_meta TEXT,                    -- ACL revision the access rows match
  visibility  TEXT NOT NULL,
  indexed_at  INTEGER NOT NULL
);
