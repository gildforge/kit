-- Agents: subaccounts a person signs in, named <sponsor>/<label> (shown as
-- @sami/codex). An agent acts with its own API tokens; revoking it stops
-- every token at once. What it may do in a repo is that repo's business:
-- grants live in the repo's .gild/acl.json on _meta.
CREATE TABLE agents (
  name TEXT PRIMARY KEY,          -- 'sami/codex'
  sponsor TEXT NOT NULL,          -- the person who signed it in
  label TEXT NOT NULL,            -- 'codex'
  public_key TEXT,                -- the agent's own key, when it has one
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX agents_sponsor ON agents (sponsor);
