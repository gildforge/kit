CREATE TABLE prepared_catalogue_observations (
  owner TEXT PRIMARY KEY COLLATE NOCASE, kind TEXT NOT NULL, generation TEXT NOT NULL,
  started_at INTEGER NOT NULL, cursor TEXT, page INTEGER NOT NULL DEFAULT 0,
  terminal INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE prepared_catalogue_pages (
  owner TEXT NOT NULL COLLATE NOCASE, generation TEXT NOT NULL, cursor_key TEXT NOT NULL,
  page INTEGER NOT NULL, next_cursor TEXT, terminal INTEGER NOT NULL,
  row_count INTEGER NOT NULL, next_offset INTEGER NOT NULL DEFAULT 0,
  digest TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(owner,generation,cursor_key), UNIQUE(owner,generation,page)
);
CREATE TABLE prepared_catalogue_page_rows (
  owner TEXT NOT NULL COLLATE NOCASE, generation TEXT NOT NULL, name TEXT NOT NULL COLLATE NOCASE,
  id TEXT NOT NULL, description TEXT, default_branch TEXT NOT NULL,
  created_at TEXT, updated_at TEXT, page INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  PRIMARY KEY(owner,generation,name), UNIQUE(owner,generation,page,ordinal)
);
CREATE INDEX prepared_catalogue_page_row_count ON prepared_catalogue_page_rows(owner,generation,page);
