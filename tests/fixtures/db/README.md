# Database fixtures

Where each `.db` here comes from is listed in [`docs/TESTING.md`](../../../docs/TESTING.md) §5. This file records the one
fixture that no script can make again.

## `otzaria-user-books-live.db`

The `user_books.db` that **Otzaria itself** wrote — not one built from the DDL — so the tool's `user_link` reader is tested
against the app's real output (V7 PR1 item 10).

- **Made by:** an isolated portable copy of the installed Otzaria `0.9.98+99803` (`otzaria-release.json`: `0.9.98.3+9`),
  with `portable.marker` and its own `otzaria_data`, in the live run 3 of 27.11.2026
  ([`docs/reviews/V7_LIVE_OTZARIA_TESTS.md`](../../../docs/reviews/V7_LIVE_OTZARIA_TESTS.md) §9). The installed app and the
  user's databases were not touched (before/after snapshot: no difference).
- **What is in it:** only the synthetic books of `scripts/live-test` (`make-bundle.mjs`, `make-v7-extra.mjs`): 7 personal books
  from two folders (their text stays in the `.txt` files, `isContentExternal = 1`), 28 `user_link` rows, the 5 links files the
  folder scan applied, and 5 files imported through "ייבוא נתונים" (synthetic links files and `links.csv`). The rows include
  the links made in the tool's own UI in that run (a plain link, a range, an anchor, two from the pattern method). The
  library side is `בראשית` of `seforim-v7-mini.db`; the attached database's book (`בדיקת מקשר - ספר ממסד אישי`) is not here.
  No book text: the only Hebrew is the synthetic titles, headings and `heRef` strings, and the paths of the test folders.
- **How it was taken:** after Otzaria was closed, the file was copied as it is (its `-wal` was 0 bytes, so the main file
  holds everything). It stays in WAL mode, as Otzaria writes it: the tool warns `db/wal`.
- **SHA-256:** `d4a188e7ed3d90d4d258c6340e100f1ab0366e47c60c61c7338f3b4307f225db` (checked by the test).
- **Used by:** `tests/integration/sources/user-links-otzaria-made.test.ts`. The expected rows there are the table as
  `scripts/live-test/inspect-user-links.py` (Python `sqlite3`, read-only) printed it.
