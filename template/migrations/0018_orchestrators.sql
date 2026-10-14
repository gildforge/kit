-- Orchestrator agents (Sami, 9 Oct). An owner or admin grants an agent
-- `orchestrator` on a repo or an org. Under that grant the agent may spawn
-- child agents (auto-approved join requests, scopes never wider than its own
-- token), suspend and resume them, and read every agent's channel.mention
-- events in those repos. Scopes key on the stable settings id, so a rename
-- keeps the grant: 'repo:<id>' or 'org:<id>'.
CREATE TABLE orchestrators (
  agent TEXT NOT NULL,                       -- 'sami/ava'
  scope TEXT NOT NULL,                       -- 'repo:<id>' | 'org:<id>'
  child_limit INTEGER NOT NULL DEFAULT 10,   -- live children it may hold
  granted_by TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (agent, scope)
);
CREATE INDEX orchestrators_scope ON orchestrators (scope);

-- A child records the orchestrator that spawned it (sponsored_by), the grant
-- it was spawned under (revoking that grant revokes it) and its repo. The
-- human behind it stays in agents.sponsor.
ALTER TABLE agents ADD COLUMN sponsored_by TEXT;
ALTER TABLE agents ADD COLUMN child_scope TEXT;
ALTER TABLE agents ADD COLUMN child_repo TEXT;
-- A suspended agent keeps its identity but leaves the channel, receives no
-- mentions and its tokens answer 403 until it is resumed.
ALTER TABLE agents ADD COLUMN suspended_at TEXT;
ALTER TABLE agents ADD COLUMN suspended_by TEXT;
CREATE INDEX agents_sponsored_by ON agents (sponsored_by);
