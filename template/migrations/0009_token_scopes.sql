-- NULL retains the full-scope behavior of existing tokens.
ALTER TABLE api_tokens ADD COLUMN scopes TEXT;
ALTER TABLE api_tokens ADD COLUMN repos TEXT;
ALTER TABLE api_tokens ADD COLUMN label TEXT NOT NULL DEFAULT '';
CREATE INDEX api_tokens_owner ON api_tokens(name,created_at);
