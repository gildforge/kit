-- A same-epoch external ref refresh cannot leave old pull heads certified.
ALTER TABLE prepared_conversation_runs ADD COLUMN refs TEXT;
