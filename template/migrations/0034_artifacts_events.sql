-- Artifacts events (lib/artifacts-events.ts). Each repository has one
-- event subscription (push, clone, fetch) delivered to the
-- gild-artifacts-events queue; account events (create, delete, fork,
-- import) come from one account-level subscription.
CREATE TABLE artifacts_subscriptions (
  namespace       TEXT NOT NULL,
  repo            TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (namespace, repo)
);
-- Operations Artifacts reported per repository and month, as delivered.
CREATE TABLE artifacts_usage (
  month     TEXT NOT NULL,              -- 'YYYY-MM'
  namespace TEXT NOT NULL,
  repo      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('pushed','cloned','fetched','created','imported','forked')),
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, namespace, repo, kind)
);
