-- Account lifecycle (lib/accounts.ts). No row = active. Statuses:
--   trial   full access until trial_ends_at, then unpaid
--   unpaid  read-only for everyone (writes 402) until delete_after, then purged
--   deleted hidden at once (owner included), restorable until delete_after
CREATE TABLE accounts (
  name          TEXT PRIMARY KEY COLLATE NOCASE,
  status        TEXT NOT NULL CHECK (status IN ('active','trial','unpaid','deleted')),
  status_at     INTEGER NOT NULL,
  trial_ends_at INTEGER,
  delete_after  INTEGER,
  previous      TEXT CHECK (previous IS NULL OR previous IN ('active','trial','unpaid')),
  reason        TEXT,
  updated_by    TEXT
);
CREATE INDEX accounts_due ON accounts(status, trial_ends_at, delete_after);
-- People who may set any account's status (until billing does it).
CREATE TABLE site_admins (name TEXT PRIMARY KEY COLLATE NOCASE);
