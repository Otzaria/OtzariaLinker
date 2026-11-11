"""
Builds tests/fixtures/db/seforim-v7-mini.db: a small, REAL slice of an Otzaria seforim.db.

    py -3 -I scripts/fixtures/make_mini_db.py C:/ProgramData/otzaria/books/seforim.db

The source is opened read-only (mode=ro). The output keeps the source's exact DDL (every table and
index, created in sqlite_master order), its schema_meta, connection_type, source, category tables
and its zstd_dict — so compressed rows decode with the real dictionary — and copies only:
  • a line slice of a few books (below), with their line_content, line_note, toc and alt_toc rows;
  • every link whose BOTH ends are in the slice, with its link_anchor/link_range/link_coverage/
    link_suppressed_side rows (range end lines are added to the slice first).
Rows are copied verbatim (compressed BLOBs stay compressed). book.totalLines keeps the source
value although only a slice of lines is present — tests must count lines, not trust totalLines.
"""
import os
import sqlite3
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else "C:/ProgramData/otzaria/books/seforim.db"
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "db", "seforim-v7-mini.db")

# (bookId, first lineIndex, last lineIndex) — all inclusive, 0-based
SLICES = [
    (1, 0, 119),      # בראשית — Sefaria base book (isBaseBook=1)
    (3201, 0, 119),   # אונקלוס על בראשית — targum
    (8441, 0, 215),   # a small Otzaria book whose footnotes live in line_note (schema 7)
]
# Rashi on Bereshit: the lines its links to the Bereshit slice land on.
DEPENDANT_OF_SLICE = [3695]
# Real anchored links already used by tests/fixtures/contracts/anchor-point.json.
EXTRA_LINK_IDS_FROM_FIXTURE = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "contracts", "anchor-point.json")


def main() -> None:
    src = sqlite3.connect(f"file:{SRC}?mode=ro", uri=True)
    if os.path.exists(OUT):
        os.remove(OUT)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out = sqlite3.connect(OUT)
    out.execute("PRAGMA page_size = 4096")
    out.execute("PRAGMA journal_mode = OFF")

    ddl = src.execute(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid"
    ).fetchall()
    for typ, name, sql in ddl:
        if typ == "table":
            out.execute(sql)
    cols = {name: [r[1] for r in src.execute(f'PRAGMA table_info("{name}")')] for typ, name, _ in ddl if typ == "table"}

    def copy(table: str, where: str, args=()) -> int:
        c = cols[table]
        rows = src.execute(f'SELECT {", ".join(f"{x}" for x in c)} FROM "{table}" WHERE {where}', args).fetchall()
        out.executemany(f'INSERT OR IGNORE INTO "{table}" ({", ".join(c)}) VALUES ({", ".join("?" * len(c))})', rows)
        return len(rows)

    for t in ("schema_meta", "connection_type", "source", "category", "category_closure", "zstd_dict"):
        copy(t, "1")

    line_ids: set[int] = set()

    def add_lines(book: int, lo: int, hi: int) -> None:
        for (lid,) in src.execute("SELECT id FROM line WHERE bookId=? AND lineIndex BETWEEN ? AND ?", (book, lo, hi)):
            line_ids.add(lid)

    for book, lo, hi in SLICES:
        add_lines(book, lo, hi)
    bereshit_lines = sorted(line_ids)

    # links from the dependants into the Bereshit slice (either stored direction)
    for dep in DEPENDANT_OF_SLICE:
        q = f"SELECT sourceLineId, targetLineId FROM link WHERE (sourceBookId=1 AND targetBookId=?) OR (sourceBookId=? AND targetBookId=1)"
        for s, t in src.execute(q, (dep, dep)):
            if s in line_ids or t in line_ids:
                line_ids.update((s, t))

    import json
    extra_link_ids = []
    with open(EXTRA_LINK_IDS_FROM_FIXTURE, encoding="utf-8") as f:
        for ex in json.load(f)["examples"]:
            for row in ex.get("dbRows", []):
                extra_link_ids.append(row["link"]["id"])
                line_ids.update((row["link"]["sourceLineId"], row["link"]["targetLineId"]))

    # range end lines join the slice, so link_range rows resolve
    def in_ids(ids):
        return ",".join(str(i) for i in ids)

    link_ids: set[int] = set()
    for chunk in chunks(sorted(line_ids), 500):
        for (lid,) in src.execute(f"SELECT id FROM link WHERE sourceLineId IN ({in_ids(chunk)})"):
            link_ids.add(lid)
    link_ids.update(extra_link_ids)
    keep_links = set()
    for chunk in chunks(sorted(link_ids), 500):
        for lid, s, t in src.execute(f"SELECT id, sourceLineId, targetLineId FROM link WHERE id IN ({in_ids(chunk)})"):
            if s in line_ids and t in line_ids:
                keep_links.add(lid)
    for chunk in chunks(sorted(keep_links), 500):
        for (end_line,) in src.execute(f"SELECT endLineId FROM link_range WHERE linkId IN ({in_ids(chunk)})"):
            line_ids.add(end_line)

    books = set()
    for chunk in chunks(sorted(line_ids), 500):
        ids = in_ids(chunk)
        copy("line", f"id IN ({ids})")
        copy("line_content", f"id IN ({ids})")
        copy("line_note", f"lineId IN ({ids})")
        copy("line_toc", f"lineId IN ({ids})")
        copy("line_alt_toc", f"lineId IN ({ids})")
        copy("tocEntry", f"lineId IN ({ids})")
        copy("alt_toc_entry", f"lineId IN ({ids})")
        books.update(b for (b,) in src.execute(f"SELECT DISTINCT bookId FROM line WHERE id IN ({ids})"))
    for chunk in chunks(sorted(keep_links), 500):
        ids = in_ids(chunk)
        for t in ("link", "link_anchor", "link_range", "link_suppressed_side"):
            copy(t, f"{'id' if t == 'link' else 'linkId'} IN ({ids})")
        copy("link_coverage", f"linkId IN ({ids}) AND lineId IN ({in_ids(line_ids)})")
    books_sql = in_ids(sorted(books))
    copy("book", f"id IN ({books_sql})")
    copy("alt_toc_structure", f"bookId IN ({books_sql})")
    copy("book_base_text", f"bookId IN ({books_sql})")
    # toc text of the copied entries
    copy("tocText", f"id IN (SELECT textId FROM tocEntry WHERE id IN ({in_ids([r[0] for r in out.execute('SELECT id FROM tocEntry')]) or 'NULL'}))")

    for typ, name, sql in ddl:
        if typ == "index":
            out.execute(sql)
    out.commit()
    out.execute("VACUUM")
    out.close()
    o = sqlite3.connect(OUT)
    stats = {t: o.execute(f'SELECT count(*) FROM "{t}"').fetchone()[0] for t in ("book", "line", "line_content", "line_note", "link", "link_anchor", "link_range", "link_coverage", "link_suppressed_side", "tocEntry", "zstd_dict")}
    print(os.path.getsize(OUT), "bytes", stats)


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


if __name__ == "__main__":
    main()
