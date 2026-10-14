CREATE TABLE profiles (name TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE profile_pictures (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL CHECK(length(bytes)<=65536), created_at INTEGER NOT NULL DEFAULT (unixepoch()*1000));
-- Stable id preserves DO, secret AAD and immutable cache identities on rename.
CREATE TABLE settings_entities (
  key TEXT PRIMARY KEY, id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER, moving INTEGER NOT NULL DEFAULT 0, description TEXT, default_branch TEXT,
  previous TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX settings_purge ON settings_entities(deleted_at);
CREATE TABLE settings_aliases (name TEXT PRIMARY KEY, target TEXT NOT NULL);
CREATE UNIQUE INDEX settings_alias_case ON settings_aliases(name COLLATE NOCASE);
CREATE UNIQUE INDEX settings_entity_case ON settings_entities(key COLLATE NOCASE);
CREATE TABLE settings_leases (id TEXT PRIMARY KEY, key TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX settings_lease_key ON settings_leases(key);
-- Concurrent owner changes are serialized by SQLite, beyond the service guard.
CREATE TRIGGER org_last_owner_delete BEFORE DELETE ON org_members
WHEN OLD.role='owner' AND EXISTS(SELECT 1 FROM orgs WHERE name=OLD.org)
 AND NOT EXISTS(SELECT 1 FROM settings_entities WHERE key=OLD.org AND deleted_at IS NOT NULL)
 AND (SELECT count(*) FROM org_members WHERE org=OLD.org AND role='owner')=1
BEGIN SELECT RAISE(ABORT,'Last owner'); END;
CREATE TRIGGER org_last_owner_demote BEFORE UPDATE OF role ON org_members
WHEN OLD.role='owner' AND NEW.role!='owner'
 AND (SELECT count(*) FROM org_members WHERE org=OLD.org AND role='owner')=1
BEGIN SELECT RAISE(ABORT,'Last owner'); END;
-- Claims and orgs share one transactional namespace (including rename staging).
CREATE TABLE owner_names (name TEXT PRIMARY KEY, kind TEXT NOT NULL);
INSERT INTO owner_names SELECT name,'user' FROM claims;
INSERT OR IGNORE INTO owner_names SELECT name,'org' FROM orgs;
CREATE TRIGGER claim_owner_name AFTER INSERT ON claims
BEGIN INSERT INTO owner_names(name,kind) VALUES(NEW.name,'user'); END;
CREATE TRIGGER org_owner_name AFTER INSERT ON orgs
BEGIN INSERT INTO owner_names(name,kind) VALUES(NEW.name,'org'); END;
-- Old physical copies are removed once after a successful rename. Redirects
-- and their reservations remain; Artifacts namespaces themselves have no delete.
CREATE TABLE settings_cleanup (key TEXT PRIMARY KEY, org INTEGER NOT NULL);

CREATE TABLE settings_renames (id TEXT PRIMARY KEY, data TEXT NOT NULL);
