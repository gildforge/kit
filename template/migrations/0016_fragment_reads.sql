-- Branch pointers are published only after their immutable projection exists.
CREATE TABLE fragment_heads (
  id TEXT NOT NULL,
  ref TEXT NOT NULL,
  pointer TEXT NOT NULL,
  manifest TEXT NOT NULL,
  PRIMARY KEY(id,ref)
);
-- Keep the two-column registry compatible with the running v1 site during
-- migration. A sidecar owns retention, rather than changing VALUES arity.
CREATE TABLE fragment_retention (
  fragment TEXT NOT NULL, id TEXT NOT NULL,
  reachable INTEGER NOT NULL DEFAULT 0,
  unreachable_at INTEGER NOT NULL,
  PRIMARY KEY(fragment,id),
  FOREIGN KEY(fragment,id) REFERENCES fragment_repos(fragment,id) ON DELETE CASCADE
);
INSERT INTO fragment_retention SELECT fragment,id,0,unixepoch()*1000 FROM fragment_repos;
CREATE TABLE fragment_reachable (id TEXT NOT NULL, fragment TEXT NOT NULL, PRIMARY KEY(id,fragment));

CREATE INDEX fragment_repo_owner ON fragment_repos(id);

CREATE TABLE fragment_backfill (id TEXT PRIMARY KEY, next_attempt INTEGER NOT NULL);
