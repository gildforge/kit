-- Participant facts are cached in RepoChannel under this immutable generation.
-- A transaction updates it alongside every membership/ACL/token/agent change.
CREATE TABLE channel_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO channel_revision VALUES (1,0);
CREATE TRIGGER channel_revision_repo_access_insert AFTER INSERT ON repo_access BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_repo_access_update AFTER UPDATE ON repo_access BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_repo_access_delete AFTER DELETE ON repo_access BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_agents_insert AFTER INSERT ON agents BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_agents_update AFTER UPDATE ON agents BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_agents_delete AFTER DELETE ON agents BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_api_tokens_insert AFTER INSERT ON api_tokens BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_api_tokens_update AFTER UPDATE ON api_tokens BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_api_tokens_delete AFTER DELETE ON api_tokens BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_org_members_insert AFTER INSERT ON org_members BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_org_members_update AFTER UPDATE ON org_members BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_org_members_delete AFTER DELETE ON org_members BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_orgs_insert AFTER INSERT ON orgs BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_orgs_update AFTER UPDATE ON orgs BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_orgs_delete AFTER DELETE ON orgs BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_orchestrators_insert AFTER INSERT ON orchestrators BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_orchestrators_update AFTER UPDATE ON orchestrators BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_orchestrators_delete AFTER DELETE ON orchestrators BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_settings_entities_insert AFTER INSERT ON settings_entities BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_settings_entities_update AFTER UPDATE ON settings_entities BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
CREATE TRIGGER channel_revision_settings_entities_delete AFTER DELETE ON settings_entities BEGIN UPDATE channel_revision SET revision=revision+1 WHERE id=1; END;
