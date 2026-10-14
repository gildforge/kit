-- The fence is written BEFORE any ACL push. Listings and fragment grants join
-- it on every read, so failed projection writes cannot retain public access.
CREATE TABLE repo_access (
  id TEXT PRIMARY KEY,
  meta TEXT,
  acl TEXT NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0
);
INSERT INTO repo_access(id,meta,acl)
SELECT id,json_extract(data,'$.meta'),coalesce(json_extract(data,'$.acl'),'{}') FROM repo_listing;
CREATE TABLE fragment_repos (
  fragment TEXT NOT NULL,
  id TEXT NOT NULL,
  PRIMARY KEY(fragment,id)
);
CREATE TABLE repo_invitations (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  invitee TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('read','write')),
  inviter TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(repo,invitee)
);
