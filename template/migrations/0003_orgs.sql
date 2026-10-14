-- Orgs: a named group that owns repos and scopes access. Names share the
-- global namespace with claims (gild.gg/<name> is one owner, user or org).
CREATE TABLE orgs (
  name TEXT PRIMARY KEY,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Roles: owner (full control, can delete), admin (manage members + repos,
-- push), member (read; push is a per-repo ACL question later).
CREATE TABLE org_members (
  org TEXT NOT NULL REFERENCES orgs(name),
  member TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (org, member)
);
