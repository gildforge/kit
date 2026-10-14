-- cqx scores, one per commit, cqx build and cqx.json. A commit's code never
-- changes, so a score is computed once and read from here after that.
CREATE TABLE IF NOT EXISTS cqx_scores (
  key TEXT PRIMARY KEY,
  report TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
