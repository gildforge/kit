ALTER TABLE repo_imports ADD COLUMN internal_prefix TEXT NOT NULL DEFAULT 'import/pr';
-- Read only active namespaces without scanning the import history.
CREATE INDEX repo_imports_internal ON repo_imports(lower(repository))
WHERE state IN ('queued','running','mirroring','failed');
