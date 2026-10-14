-- Anonymous HTML is produced by writes/cron, never by a visitor. Every row
-- names immutable R2 bytes and the public repo grants used while rendering.
CREATE TABLE public_pages (
  route TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  input TEXT NOT NULL,
  dependencies TEXT NOT NULL,
  owner TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE public_page_jobs (
  route TEXT PRIMARY KEY,
  owner TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE public_page_artifacts (input TEXT PRIMARY KEY, hash TEXT NOT NULL);
CREATE TABLE public_asset_builds (build TEXT PRIMARY KEY);
