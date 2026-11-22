"""
Builds tests/fixtures/db/pdc-personal-mini.db: a tiny personal database in the layout that Personal-DB-Creator
(YairDaniel11/Personal-DB-Creator) writes — the links live in `external_link`, there is no `link` table.

    py -3 -I scripts/fixtures/make_pdc_mini_db.py C:/Users/User/Documents/DEV/otzarya-unofficial-books-52.db

SOURCE OF THE SCHEMA (ADR 0004: no invented schemas). The DDL of every table and index is copied VERBATIM from
sqlite_master of a real personal database of this kind — "otzarya-unofficial-books" db_version 52, opened
read-only (mode=ro), SHA-256 8679a2ea55828701581600cdae363d4ee97f48813b10f7277ce4385405417992, measured in
docs/research/PERSONAL_DB_V52_AUDIT.md. Only DDL is read from it.

ROWS ARE PLACEHOLDERS. That database is copyright-restricted, so no row, title, text or dictionary of it is
copied (not even schema_meta values or its zstd_dict). Every row below is a short synthetic string that says
"PLACEHOLDER". Two deliberate differences from the real file, both forced by that:
  • `line_content.content` holds TEXT, not a zstd BLOB (the column is declared BLOB, so SQLite stores either;
    the reader returns TEXT as it is) and `zstd_dict` is empty;
  • line.id follows the real database's rule `bookId * 2^20 + lineIndex + 1`, so a book with a high id has
    line ids above 2^32 (the real file reaches 10,332,667,988), as the real database does.
The official counterpart of the targets is tests/fixtures/db/seforim-v7-mini.db: its title "בראשית" and the heRef
labels of its lines 3-5 ("בראשית, א, ב"...) are public reference labels, not book text.

Rows (book ids are the real database's style: sparse):
  11 PLACEHOLDER base, 12 PLACEHOLDER notes on base (internal links), 9854 PLACEHOLDER commentary on official
  (links into the official database; id 9854 puts its line ids above 2^32).
"""
import os
import sqlite3
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "C:/Users/User/Documents/DEV/otzarya-unofficial-books-52.db"
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "db", "pdc-personal-mini.db")
LIB = "pdc-fixture"

BOOKS = [  # id, title, lines
    (11, "PLACEHOLDER base", 4),
    (12, "PLACEHOLDER notes on base", 4),
    (9854, "PLACEHOLDER commentary on official", 6),
]
# sourceBookId, sourceLineIndex, targetSource, targetTitle, targetRef, targetLineIndex, connectionType
EXTERNAL = [
    (9854, 0, "official", "בראשית", "בראשית, א, ב", 3, "SOURCE"),            # resolves by heRef AND by index
    (9854, 1, "official", "בראשית", "בראשית, א, ג", 4, "SOURCE"),
    (9854, 2, "official", "בראשית", "בראשית, א, ד", 9999, "SOURCE"),         # heRef wins over a wrong index
    (9854, 3, "official", "PLACEHOLDER not in the library", "PLACEHOLDER ref", 0, "SOURCE"),  # unresolved title
    (9854, 4, "official", "בראשית", None, 100000, "SOURCE"),                 # index beyond the book: out of range
    (11, 0, LIB, "PLACEHOLDER notes on base", None, 0, "FOOTNOTES"),          # internal: base -> notes
    (11, 1, LIB, "PLACEHOLDER notes on base", None, 1, "FOOTNOTES"),
    (12, 0, LIB, "PLACEHOLDER base", None, 2, None),                          # NULL connectionType = REFERENCE
    (11, 3, LIB, "PLACEHOLDER commentary on official", None, 5, "COMMENTARY"),  # internal, other direction pair ...
    (9854, 5, LIB, "PLACEHOLDER base", None, 3, "SOURCE"),                    # ... and its reverse (a reverse duplicate)
]


def main() -> None:
    src = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True)
    ddl = src.execute("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").fetchall()
    if os.path.exists(OUT):
        os.remove(OUT)
    out = sqlite3.connect(OUT)
    out.execute("PRAGMA page_size = 4096")
    out.execute("PRAGMA journal_mode = OFF")
    for typ, _name, sql in ddl:
        if typ == "table":
            out.execute(sql)
    for typ, _name, sql in ddl:
        if typ == "index":
            out.execute(sql)

    out.executemany("INSERT INTO schema_meta (key, value) VALUES (?, ?)", [
        ("library_id", LIB), ("library_name", "PLACEHOLDER personal library"), ("db_version", "1"),
    ])
    out.execute("INSERT INTO connection_type (id, name) VALUES (1, 'SOURCE')")  # the real file has this one row
    out.execute("INSERT INTO source (id, name) VALUES (1, 'PLACEHOLDER source')")
    out.execute("INSERT INTO category (id, parentId, title, level, orderIndex) VALUES (1, NULL, 'PLACEHOLDER category', 0, 1)")
    line_id = 0
    for bid, title, n in BOOKS:
        out.execute(
            "INSERT INTO book (id, categoryId, sourceId, title, orderIndex, totalLines, isBaseBook, hasSourceConnection) VALUES (?, 1, 1, ?, 1, ?, 0, ?)",
            (bid, title, n, 1 if bid != 12 else 0),
        )
        for i in range(n):
            line_id = bid * 2**20 + i + 1
            out.execute("INSERT INTO line (id, bookId, lineIndex, heRef, tocEntryId) VALUES (?, ?, ?, NULL, NULL)", (line_id, bid, i))
            out.execute("INSERT INTO line_content (id, content) VALUES (?, ?)", (line_id, f"PLACEHOLDER line {bid}/{i}"))
    out.executemany(
        "INSERT INTO external_link (sourceBookId, sourceLineIndex, targetSource, targetTitle, targetRef, targetLineIndex, connectionType) VALUES (?, ?, ?, ?, ?, ?, ?)",
        EXTERNAL,
    )
    out.commit()
    out.execute("VACUUM")
    out.close()
    print(f"wrote {OUT}: {len(BOOKS)} books, {len(EXTERNAL)} external_link rows")


if __name__ == "__main__":
    main()
