-- Immutable producer snapshots. Ref epoch/meta/current ACL are rechecked on
-- every read; staging pages do not become readable until the complete receipt.
CREATE TABLE prepared_search_documents (
  snapshot TEXT NOT NULL,
  path TEXT NOT NULL,
  blob TEXT NOT NULL,
  language TEXT NOT NULL,
  content TEXT NOT NULL,
  symbols TEXT NOT NULL,
  search_path TEXT NOT NULL,
  search_content TEXT NOT NULL,
  PRIMARY KEY(snapshot,path)
);
CREATE TABLE prepared_search_receipts (
  snapshot TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  ref TEXT NOT NULL,
  tip TEXT NOT NULL,
  meta TEXT,
  document_count INTEGER NOT NULL
);
CREATE INDEX prepared_search_repository ON prepared_search_receipts(id,epoch,ref,tip);
-- D1 supports FTS5/trigram. Lowercasing uses the same JS Unicode semantics as
-- search-query.matches; FTS is only a safe candidate filter, never the evaluator.
CREATE VIRTUAL TABLE prepared_search_fts USING fts5(
  path,content,tokenize='trigram case_sensitive 1'
);
CREATE TRIGGER prepared_search_insert AFTER INSERT ON prepared_search_documents BEGIN
  INSERT INTO prepared_search_fts(rowid,path,content) VALUES(new.rowid,new.search_path,new.search_content);
END;
CREATE TRIGGER prepared_search_delete AFTER DELETE ON prepared_search_documents BEGIN
  DELETE FROM prepared_search_fts WHERE rowid=old.rowid;
END;
CREATE TRIGGER prepared_search_update AFTER UPDATE ON prepared_search_documents BEGIN
  DELETE FROM prepared_search_fts WHERE rowid=old.rowid;
  INSERT INTO prepared_search_fts(rowid,path,content) VALUES(new.rowid,new.search_path,new.search_content);
END;
