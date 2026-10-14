-- Private access is read live from the main database's policy at query time
-- (lib/search-index.ts readablePrivate), never copied here.
DROP TABLE search_access;
