"""Cuts a tiny, REAL seforim.db for the app-code check of the live-test bundle (docs/LIVE_TESTING.md §7).

    py -3 -I scripts/live-test/make-app-slice.py <out.db> <bookId>:<first>-<last>[=<new title>] [...] [--src <seforim.db>]

The two slices of the Dart check (docs/LIVE_TESTING.md §7):
    py -3 -I scripts/live-test/make-app-slice.py .bench/app-slice/seforim.db 1:0-11 3695:0-7
    py -3 -I scripts/live-test/make-app-slice.py .bench/app-slice/attached.db "8441:0-15=בדיקת מקשר - ספר ממסד אישי" 1:0-11

"=<new title>" renames the book in the copy: a personal database's book must not share its title with an
official one (the app would bind the links to the official book: user_content_importer.dart:713-732).

The source (default C:/ProgramData/otzaria/books/seforim.db) is opened READ-ONLY and immutable; nothing
is written to it, and it is never copied whole. The output keeps the source's exact DDL (every table and
index, in sqlite_master order) and its small global tables (schema_meta, source, connection_type,
category, category_closure, zstd_dict, so compressed rows decode), and copies only the given books and
the given 0-based line ranges of each, with their line_content, line_toc and tocEntry/tocText rows. No
link rows: the check is about the links the user imports. book.totalLines keeps the source value.
"""
import os
import sqlite3
import sys

sys.stdout.reconfigure(encoding="utf-8")

GLOBAL_TABLES = ("schema_meta", "source", "connection_type", "category", "category_closure", "zstd_dict")


def main(argv: list[str]) -> int:
    src_path = "C:/ProgramData/otzaria/books/seforim.db"
    if "--src" in argv:
        i = argv.index("--src")
        src_path = argv[i + 1]
        argv = argv[:i] + argv[i + 2 :]
    if len(argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    out_path, specs = argv[0], argv[1:]
    slices = []
    for spec in specs:
        book, rng = spec.split(":", 1)
        rng, _, title = rng.partition("=")
        lo, hi = rng.split("-")
        slices.append((int(book), int(lo), int(hi), title or None))

    src = sqlite3.connect(f"file:{src_path}?mode=ro&immutable=1", uri=True)
    if os.path.exists(out_path):
        os.remove(out_path)
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    out = sqlite3.connect(out_path)
    out.execute("PRAGMA journal_mode = OFF")

    ddl = src.execute(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
    ).fetchall()
    for typ, _, sql in ddl:
        if typ == "table":
            out.execute(sql)
    cols = {name: [r[1] for r in src.execute(f'PRAGMA table_info("{name}")')] for typ, name, _ in ddl if typ == "table"}

    def copy(table: str, where: str, args=()) -> int:
        if table not in cols:
            return 0
        c = cols[table]
        rows = src.execute(f'SELECT {", ".join(c)} FROM "{table}" WHERE {where}', args).fetchall()
        out.executemany(f'INSERT OR IGNORE INTO "{table}" ({", ".join(c)}) VALUES ({", ".join("?" * len(c))})', rows)
        return len(rows)

    for t in GLOBAL_TABLES:
        copy(t, "1")
    for book, lo, hi, title in slices:
        copy("book", "id = ?", (book,))
        if title:
            out.execute("UPDATE book SET title = ? WHERE id = ?", (title, book))
        ids = [r[0] for r in src.execute("SELECT id FROM line WHERE bookId = ? AND lineIndex BETWEEN ? AND ?", (book, lo, hi))]
        if not ids:
            continue
        in_ids = ",".join(str(i) for i in ids)
        copy("line", f"id IN ({in_ids})")
        copy("line_content", f"id IN ({in_ids})")
        copy("line_toc", f"lineId IN ({in_ids})")
        copy("tocEntry", f"lineId IN ({in_ids})")
    copy("tocText", f"id IN (SELECT textId FROM tocEntry WHERE id IN ({','.join(str(r[0]) for r in out.execute('SELECT id FROM tocEntry')) or 'NULL'}))")

    for typ, _, sql in ddl:
        if typ == "index":
            out.execute(sql)
    out.commit()
    out.execute("VACUUM")
    out.close()
    o = sqlite3.connect(out_path)
    books = o.execute("SELECT id, title, totalLines FROM book ORDER BY id").fetchall()
    print(os.path.getsize(out_path), "bytes;", o.execute("SELECT count(*) FROM line").fetchone()[0], "lines;", books)
    o.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
