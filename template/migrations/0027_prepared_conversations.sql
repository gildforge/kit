-- Producer staging is invisible until a complete, current-epoch receipt exists.
CREATE TABLE prepared_conversation_runs (
  id TEXT NOT NULL, generation TEXT NOT NULL, epoch INTEGER NOT NULL, meta TEXT,
  repository TEXT NOT NULL, threads INTEGER NOT NULL, comments INTEGER NOT NULL,
  reviews INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id,generation)
);
CREATE TABLE prepared_conversation_receipts (
  id TEXT PRIMARY KEY, generation TEXT NOT NULL, epoch INTEGER NOT NULL, meta TEXT
);
CREATE TABLE prepared_conversation_threads (
  id TEXT NOT NULL, generation TEXT NOT NULL, number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('issue','pr')), state TEXT NOT NULL,
  updated_at TEXT NOT NULL, comments INTEGER NOT NULL, reviews INTEGER NOT NULL,
  labels TEXT NOT NULL, data TEXT NOT NULL, head TEXT, base TEXT,
  PRIMARY KEY (id,generation,number,kind)
);
CREATE INDEX prepared_conversation_listing ON prepared_conversation_threads(id,generation,state,number);
CREATE INDEX prepared_conversation_updated ON prepared_conversation_threads(id,generation,updated_at,number);
CREATE INDEX prepared_conversation_comment_sort ON prepared_conversation_threads(id,generation,comments,number);
CREATE TABLE prepared_conversation_comments (
  id TEXT NOT NULL, generation TEXT NOT NULL, number INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('issue','pr')), source_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL, inline INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (id,generation,number,kind,source_id)
);
CREATE INDEX prepared_conversation_comment_page ON prepared_conversation_comments(id,generation,number,kind,ordinal,source_id);
CREATE TABLE prepared_conversation_reviews (
  id TEXT NOT NULL, generation TEXT NOT NULL, number INTEGER NOT NULL,
  source_id TEXT NOT NULL, ordinal INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (id,generation,number,source_id)
);
CREATE INDEX prepared_conversation_review_page ON prepared_conversation_reviews(id,generation,number,ordinal,source_id);
