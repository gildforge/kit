CREATE TABLE IF NOT EXISTS repo_imports (
  repository TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS repo_imports_ready ON repo_imports(state,updated);
