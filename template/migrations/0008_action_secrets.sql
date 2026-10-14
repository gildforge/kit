CREATE TABLE IF NOT EXISTS action_secrets (
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  cipher TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY(repo,name)
);
