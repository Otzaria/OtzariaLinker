Hostile SQLite files for robustness tests (made by the security review, 2026-11-11, from a small
generated DB with `PRAGMA writable_schema`/page edits):
- `cycle.db` — the interior root page of `book` points its right child at itself (a b-tree cycle).
- `bracket.db` — `sqlite_master.sql` of a table is `CREATE TABLE line([id INTEGER)` (unterminated `[`).
Opening either must fail with a clear error, never hang or exhaust memory.
