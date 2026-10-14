-- Immutable/tool-version keyed reports; incomplete reports remain no-store.
CREATE TABLE prepared_repository_health (
  cache_key TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  sha TEXT NOT NULL,
  data TEXT NOT NULL,
  complete INTEGER NOT NULL,
  observed_at INTEGER NOT NULL
);
CREATE INDEX prepared_health_identity ON prepared_repository_health(id,sha);
