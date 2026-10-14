-- repo is the stable settings entity id, so stars survive repository/org renames.
CREATE TABLE stars (
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo, name)
);
