-- Agents ask to join, people approve (the way a new machine joins a
-- tailnet). The agent makes its own key and files a request naming the
-- person it works for; that person, or an agent they made an approver,
-- approves or denies. The agent then proves its key to collect a token, so
-- no token is ever stored or sent in a link.
CREATE TABLE agent_requests (
  id TEXT PRIMARY KEY,              -- random, in the approval link
  sponsor TEXT NOT NULL,            -- the person asked
  label TEXT NOT NULL,              -- the agent's name under them
  public_key TEXT NOT NULL,         -- the agent's own key
  repo TEXT,                        -- owner/name it wants to work in, if any
  grants TEXT NOT NULL DEFAULT '[]',-- what it asks for there (JSON)
  note TEXT,                        -- why, in the agent's words
  status TEXT NOT NULL,             -- pending | approved | denied
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  token_issued INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX agent_requests_sponsor ON agent_requests (sponsor, status);

-- An approver agent may approve new agents for its sponsor; approved_by
-- records who let each agent in (the sponsor, or one of their approvers).
ALTER TABLE agents ADD COLUMN approver INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN approved_by TEXT;
