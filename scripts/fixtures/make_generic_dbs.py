"""
Builds tests/fixtures/db/generic/*.db: small SQLite databases that are NOT in Otzaria's schema, for
the mapping wizard (generic SQLite sources).

    py -3 -I scripts/fixtures/make_generic_dbs.py

Unlike the other fixtures these are synthetic ON PURPOSE: the feature exists to read schemas nobody
designed for Otzaria, so the fixtures are deliberately different, typical shapes (a books table plus
a lines table, one table per line, compressed text, no text at all). The text is short generated
Hebrew. Deterministic: running the script again gives the same rows (the files may differ in
SQLite's header counters only).

The large database for the speed check (50,000 lines) is generated at test time with sql.js
(tests/integration/database/mapped-reader.test.ts), so it is not kept in the repository.
"""
import gzip
import os
import sqlite3
import zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "db", "generic")

WORDS = "בראשית ברא אלהים את השמים ואת הארץ והארץ היתה תהו ובהו וחשך על פני תהום ורוח מרחפת המים".split()


def sentence(seed: int, n: int = 8) -> str:
    return " ".join(WORDS[(seed * 7 + i * 3) % len(WORDS)] for i in range(n))


def fresh(name: str) -> sqlite3.Connection:
    path = os.path.join(OUT, name)
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.execute("PRAGMA page_size = 4096")
    db.execute("PRAGMA journal_mode = OFF")
    return db


def books_lines() -> None:
    """Two tables: works(id, name, category) and paragraphs(work_id, seq, body, level), no index on
    paragraphs (the reader must scan once). Rows are inserted OUT of order — seq decides the order —
    and one paragraph belongs to no work. A connections table links paragraph ids."""
    db = fresh("books-lines.db")
    db.executescript(
        """
        CREATE TABLE works (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT);
        CREATE TABLE paragraphs (
          id INTEGER PRIMARY KEY,
          work_id INTEGER NOT NULL, -- refers to works.id
          seq INTEGER NOT NULL,     /* order inside the work */
          body TEXT,
          level INTEGER             -- 1-6 for headings, NULL otherwise
        );
        CREATE TABLE connections (id INTEGER PRIMARY KEY, from_line INTEGER, to_line INTEGER, kind TEXT);
        """
    )
    works = [(1, "ספר הדוגמה", "דוגמאות"), (2, "פירוש על ספר הדוגמה", "פירושים"), (3, "ספר ריק", None)]
    db.executemany("INSERT INTO works VALUES (?,?,?)", works)
    rows = []
    ids = {}
    k = 0
    for work, count in ((1, 12), (2, 6)):
        for pos in range(count):
            k += 1
            pid = 100 + (k * 7) % 19  # ids (= rowid order) deliberately NOT in reading order
            ids[(work, pos)] = pid
            level = 1 if pos == 0 else None
            body = f"<b>{sentence(work * 100 + pos)}</b>" if pos % 5 == 3 else sentence(work * 100 + pos)
            if level:
                body = works[work - 1][1]
            rows.append((pid, work, pos * 10, body, level))
    db.executemany("INSERT INTO paragraphs VALUES (?,?,?,?,?)", rows)
    db.execute("INSERT INTO paragraphs VALUES (999, 42, 0, 'שורה של ספר שאינו קיים', NULL)")
    # commentary line N → base line N; the last one points at a paragraph that does not exist
    db.executemany(
        "INSERT INTO connections VALUES (?,?,?,?)",
        [(1, ids[(2, 1)], ids[(1, 1)], "commentary"), (2, ids[(2, 2)], ids[(1, 2)], "commentary"), (3, ids[(2, 3)], ids[(1, 3)], "reference"), (4, ids[(2, 4)], 5000, "commentary")],
    )
    db.commit()
    db.close()


def single_table() -> None:
    """One table: every row is a line, book_title names its book; HTML with <h1>/<h2> headings;
    an index on (book_title, line_no)."""
    db = fresh("single-table.db")
    db.executescript(
        """
        CREATE TABLE corpus (book_title TEXT, line_no INTEGER, html TEXT, source_file TEXT);
        CREATE INDEX corpus_book_line ON corpus (book_title, line_no);
        """
    )
    rows = []
    for b, title in enumerate(["מדרש לדוגמה", "קובץ שיעורים"]):
        rows.append((title, 1, f"<h1>{title}</h1>", f"{title}.txt"))
        rows.append((title, 2, "<h2>פרק א</h2>", f"{title}.txt"))
        for i in range(3, 11):
            rows.append((title, i, f"<p>{sentence(b * 50 + i)}</p>", f"{title}.txt"))
    rows.sort(key=lambda r: (r[1] * 13 + len(r[0])) % 17)
    db.executemany("INSERT INTO corpus VALUES (?,?,?,?)", rows)
    db.commit()
    db.close()


def compressed() -> None:
    """Text stored as BLOBs: gzip, zlib and plain UTF-8 bytes, one value each kind per book."""
    db = fresh("compressed.db")
    db.executescript(
        """
        CREATE TABLE book (book_id INTEGER PRIMARY KEY, title TEXT);
        CREATE TABLE line (book_id INTEGER, idx INTEGER, data BLOB, PRIMARY KEY (book_id, idx)) WITHOUT ROWID;
        """
    )
    db.execute("INSERT INTO book VALUES (7, 'ספר דחוס')")
    for i in range(9):
        text = sentence(i).encode("utf-8")
        blob = gzip.compress(text, mtime=0) if i % 3 == 0 else zlib.compress(text) if i % 3 == 1 else text
        db.execute("INSERT INTO line VALUES (7, ?, ?)", (i, blob))
    db.commit()
    db.close()


def no_text() -> None:
    """Nothing that could be a book: numbers and opaque binary only."""
    db = fresh("no-text.db")
    db.executescript("CREATE TABLE measurements (id INTEGER PRIMARY KEY, sensor INTEGER, value REAL, raw BLOB);")
    db.executemany(
        "INSERT INTO measurements VALUES (?,?,?,?)",
        [(i, i % 3, i * 0.5, bytes([0, 255, i % 256, 0x89, 0x50, 0x4E, 0x47])) for i in range(1, 30)],
    )
    db.commit()
    db.close()


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    books_lines()
    single_table()
    compressed()
    no_text()
    for name in sorted(os.listdir(OUT)):
        print(name, os.path.getsize(os.path.join(OUT, name)))


if __name__ == "__main__":
    main()
