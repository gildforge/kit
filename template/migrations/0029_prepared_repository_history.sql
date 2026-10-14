-- Immutable commit facts, producer-complete ancestry inventories and prepared
-- comparisons. An ordinary GET never discovers or walks repository history.
CREATE TABLE prepared_history_commits (
  id TEXT NOT NULL,version TEXT NOT NULL,sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','notfound')),data TEXT,
  PRIMARY KEY(id,version,sha)
);
CREATE TABLE prepared_history_nodes (
  id TEXT NOT NULL,version TEXT NOT NULL,root TEXT NOT NULL,sha TEXT NOT NULL,time INTEGER NOT NULL,
  PRIMARY KEY(id,version,root,sha)
);
CREATE INDEX prepared_history_page ON prepared_history_nodes(id,version,root,time DESC,sha);
CREATE TABLE prepared_history_receipts (
  id TEXT NOT NULL,version TEXT NOT NULL,root TEXT NOT NULL,total INTEGER NOT NULL,
  PRIMARY KEY(id,version,root)
);
CREATE TABLE prepared_history_details (
  id TEXT NOT NULL,version TEXT NOT NULL,sha TEXT NOT NULL,parent TEXT,data TEXT NOT NULL,
  PRIMARY KEY(id,version,sha)
);
CREATE TABLE prepared_history_comparisons (
  id TEXT NOT NULL,version TEXT NOT NULL,base TEXT NOT NULL,head TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','unrelated')),data TEXT,
  PRIMARY KEY(id,version,base,head)
);
CREATE TABLE prepared_history_comparison_nodes (
  id TEXT NOT NULL,version TEXT NOT NULL,base TEXT NOT NULL,head TEXT NOT NULL,
  position INTEGER NOT NULL,sha TEXT NOT NULL,
  PRIMARY KEY(id,version,base,head,position)
);
