"""Shows what the Otzaria app stored from the live-test bundle (docs/LIVE_TESTING.md, check 13).

    py -3 -I scripts/live-test/inspect-user-links.py [path to user_books.db]

Default path: C:/ProgramData/otzaria/databases/user_books.db. The database is opened READ-ONLY
(SQLite URI mode=ro); nothing is written. It prints, for the bundle's books only:
  * user_link rows - the links the app imported (stored 0-based; printed 1-based, as in the files);
    `source` is the links file's path for the personal-folder flow, empty for Settings import;
  * user_sidecar_file - the links files the folder scan applied (a file that failed has no row);
  * user_import_file - files added through Settings > "ייבוא נתונים".
Table and column names: Otzaria/otzaria upstream/dev@ceff2b13, lib/migration/database/daos/database.dart:862
(CREATE TABLE user_link) and user_content_import/repository/user_content_repository.dart:398-496.
"""

import io
import sqlite3
import sys
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

TITLES = ("בדיקת מקשר%", "הערות לבדיקת מקשר%")
DEFAULT = "C:/ProgramData/otzaria/databases/user_books.db"


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT)
    if not path.is_file():
        print(f"not found: {path}", file=sys.stderr)
        return 2
    con = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    like = " OR ".join(["sourceTitle LIKE ? OR targetTitle LIKE ?"] * len(TITLES))
    args = [t for t in TITLES for _ in (0, 1)]
    rows = con.execute(
        "SELECT sourceTitle, sourceIsUserBook, sourceLineIndex, sourceLineIndexEnd, targetTitle,"
        " targetIsUserBook, targetLineIndex, targetLineIndexEnd, connectionType, anchorStart, anchorEnd,"
        f" anchorLabel, targetRef, source FROM user_link WHERE {like}"
        " ORDER BY source IS NULL, source, sourceTitle, sourceLineIndex, targetTitle, targetLineIndex",
        args,
    ).fetchall()
    print(f"user_link: {len(rows)} rows (line numbers below are 1-based, as in the files)")
    print("\t".join(["source book", "line", "→ target book", "line", "type", "anchor", "label", "from file"]))
    for r in rows:
        def line(i, end):
            if i is None:
                return "?"
            return f"{i + 1}" if end is None or end == i else f"{i + 1}-{end + 1}"

        who = lambda title, user: f"{title}{'' if user else ' (רשמי)'}"
        anchor = "" if r["anchorStart"] is None else f"{r['anchorStart']}" + ("" if r["anchorEnd"] is None else f"-{r['anchorEnd']}")
        origin = "ייבוא נתונים" if r["source"] is None else Path(r["source"]).name
        print("\t".join([
            who(r["sourceTitle"], r["sourceIsUserBook"]), line(r["sourceLineIndex"], r["sourceLineIndexEnd"]),
            who(r["targetTitle"], r["targetIsUserBook"]), line(r["targetLineIndex"], r["targetLineIndexEnd"]),
            r["connectionType"], anchor, r["anchorLabel"] or "", origin,
        ]))

    print()
    files = con.execute("SELECT path FROM user_sidecar_file WHERE path LIKE '%_links.json' ORDER BY path").fetchall()
    print(f"user_sidecar_file: {len(files)} links files applied by the folder scan")
    for f in files:
        print(f"  {f['path']}")

    print()
    imports = con.execute("SELECT name, originPath, enabled FROM user_import_file ORDER BY importedAt, id").fetchall()
    print(f"user_import_file: {len(imports)} files from Settings import")
    for f in imports:
        print(f"  {'פעיל' if f['enabled'] else 'מושהה'}\t{f['name']}\t{f['originPath']}")
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
