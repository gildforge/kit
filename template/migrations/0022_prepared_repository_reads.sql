-- Mutable ref receipts are fenced by the producer before acknowledging pushes.
CREATE TABLE prepared_repository_refs (
  id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 1,
  meta TEXT,
  data TEXT,
  observed_at INTEGER
);
