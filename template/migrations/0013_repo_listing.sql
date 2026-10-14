-- Mutable pointer to the last published index snapshot. Its code facts and
-- metadata counts are computed once in the DO under commit/_meta tip keys.
CREATE TABLE repo_listing (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL
);
