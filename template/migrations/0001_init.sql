CREATE TABLE IF NOT EXISTS challenges (
  challenge TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- 'auth' | 'claim'
  payload TEXT NOT NULL,         -- JSON: claim fields for kind=claim
  answer TEXT,                   -- JSON: {publicKey, signature} once answered
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS claims (
  name TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  claimed_at TEXT NOT NULL
);
