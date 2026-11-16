"""
Builds tests/fixtures/db/wizard/*.db: one tiny SQLite database per STRUCTURE that the mapping wizard
(generic SQLite sources) meets in the wild, for the structure audit and its fixture tests
(tests/integration/database/wizard-structures.test.ts).

    py -I scripts/fixtures/make_wizard_dbs.py

Synthetic ON PURPOSE, like make_generic_dbs.py: the wizard exists for schemas nobody designed for
Otzaria, so each file is one typical shape, kept as small as SQLite allows (1 KiB pages, a handful of
rows of short generated Hebrew). Deterministic: running the script again gives the same rows.

Shapes with books: one book per row, one line per row, books + lines (with and without a FOREIGN KEY,
no hints in the names, no indexes), JSON chapters, chapters + lines, BLOB text (UTF-8, UTF-16, a
legacy 8-bit code page), compressed text (zlib, zstd), text split into chunks, composite keys (rowid
and WITHOUT ROWID), a separate links table, several versions of a book, a TOC table, a UTF-16
database file. Shapes without books: settings + log, an FTS5 index (contentless, and with its text
stored), views over a key/value table, a library catalog (details of books, no text), empty tables.
"""
import json
import os
import sqlite3
import zlib

try:  # Python 3.14+
    from compression import zstd
except ImportError:  # pragma: no cover
    zstd = None

OUT = os.path.join(os.path.dirname(__file__), "..", "..", "tests", "fixtures", "db", "wizard")

WORDS = "בראשית ברא אלהים את השמים ואת הארץ והארץ היתה תהו ובהו וחשך על פני תהום ורוח מרחפת המים".split()
TITLES = ["ספר הדוגמה", "פירוש על ספר הדוגמה", "קובץ שיעורים"]


def sentence(seed: int, n: int = 8) -> str:
    return " ".join(WORDS[(seed * 7 + i * 3) % len(WORDS)] for i in range(n))


def book_lines(b: int, count: int = 8) -> list[str]:
    """Line 0 is the title as an <h1>, line 3 a chapter heading, the rest sentences."""
    out = [f"<h1>{TITLES[b % len(TITLES)]}</h1>"]
    for i in range(1, count):
        out.append("<h2>פרק ב</h2>" if i == 3 else sentence(b * 50 + i))
    return out


def fresh(name: str, encoding: str | None = None) -> sqlite3.Connection:
    path = os.path.join(OUT, name)
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.execute("PRAGMA page_size = 1024")
    db.execute("PRAGMA journal_mode = OFF")
    if encoding:
        db.execute(f"PRAGMA encoding = '{encoding}'")
    return db


def done(db: sqlite3.Connection) -> None:
    db.commit()
    db.execute("VACUUM")
    db.close()


# ---------------------------------------------------------------- shapes with books


def book_per_row() -> None:
    """books(id, title, author, content): the whole book in one cell, lines separated by newlines."""
    db = fresh("book-per-row.db")
    db.execute("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT, content TEXT)")
    for b in range(3):
        db.execute("INSERT INTO books VALUES (?,?,?,?)", (b + 1, TITLES[b], "מחבר לדוגמה", "\n".join(book_lines(b))))
    done(db)


def line_per_row() -> None:
    """lines(book, line_no, text): every row is a line and names its book; index on (book, line_no)."""
    db = fresh("line-per-row.db")
    db.executescript("CREATE TABLE lines (book TEXT, line_no INTEGER, text TEXT); CREATE INDEX lines_book ON lines (book, line_no);")
    rows = [(TITLES[b], i, t) for b in range(2) for i, t in enumerate(book_lines(b))]
    rows.sort(key=lambda r: (r[1] * 5 + len(r[0])) % 11)  # rowid order is not reading order
    db.executemany("INSERT INTO lines VALUES (?,?,?)", rows)
    done(db)


def books_lines_fk() -> None:
    """book + line with a declared FOREIGN KEY and an index on (book_id, line_index)."""
    db = fresh("books-lines-fk.db")
    db.executescript(
        """
        CREATE TABLE book (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE line (id INTEGER PRIMARY KEY, book_id INTEGER NOT NULL REFERENCES book(id), line_index INTEGER NOT NULL, content TEXT);
        CREATE INDEX line_book ON line (book_id, line_index);
        """
    )
    for b in range(2):
        db.execute("INSERT INTO book VALUES (?,?)", (b + 1, TITLES[b]))
        db.executemany("INSERT INTO line (book_id, line_index, content) VALUES (?,?,?)", [(b + 1, i, t) for i, t in enumerate(book_lines(b))])
    done(db)


def books_lines_nofk() -> None:
    """Two tables whose names give nothing away, no FOREIGN KEY, no index: t_main(k, label) and
    t_items(parent, pos, payload). Only the values tie them together."""
    db = fresh("books-lines-nofk.db")
    db.executescript(
        """
        CREATE TABLE t_main (k INTEGER PRIMARY KEY, label TEXT);
        CREATE TABLE t_items (parent INTEGER, pos INTEGER, payload TEXT);
        """
    )
    for b in range(2):
        db.execute("INSERT INTO t_main VALUES (?,?)", (b + 10, TITLES[b]))
    rows = [(b + 10, i, t) for b in range(2) for i, t in enumerate(book_lines(b))]
    rows.sort(key=lambda r: (r[1] * 3 + r[0]) % 7)
    db.executemany("INSERT INTO t_items VALUES (?,?,?)", rows)
    done(db)


def json_chapters() -> None:
    """books(id, title, chapters): a JSON array of chapters, each an array of lines; one book uses
    objects {"title": …, "verses": […]} instead."""
    db = fresh("json-chapters.db")
    db.execute("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, chapters TEXT)")
    a = [[sentence(c * 10 + v) for v in range(3)] for c in range(3)]
    b = [{"title": f"פרק {'אבג'[c]}", "verses": [sentence(100 + c * 10 + v) for v in range(2)]} for c in range(3)]
    db.execute("INSERT INTO books VALUES (1, ?, ?)", (TITLES[0], json.dumps(a, ensure_ascii=False)))
    db.execute("INSERT INTO books VALUES (2, ?, ?)", (TITLES[1], json.dumps(b, ensure_ascii=False)))
    done(db)


def chapters_lines() -> None:
    """books → chapters(book_id, num, name) → verses(chapter_id, num, text): the lines refer to a
    chapter, not to the book."""
    db = fresh("chapters-lines.db")
    db.executescript(
        """
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);
        CREATE TABLE chapters (id INTEGER PRIMARY KEY, book_id INTEGER, num INTEGER, name TEXT);
        CREATE TABLE verses (id INTEGER PRIMARY KEY, chapter_id INTEGER, num INTEGER, text TEXT);
        """
    )
    ch = 0
    for b in range(2):
        db.execute("INSERT INTO books VALUES (?,?)", (b + 1, TITLES[b]))
        for c in range(3):
            ch += 1
            db.execute("INSERT INTO chapters VALUES (?,?,?,?)", (ch, b + 1, c + 1, f"פרק {'אבג'[c]}"))
            db.executemany("INSERT INTO verses (chapter_id, num, text) VALUES (?,?,?)", [(ch, v + 1, sentence(b * 50 + c * 5 + v)) for v in range(3)])
    done(db)


def blob_text(name: str, encode) -> None:
    db = fresh(name)
    db.executescript("CREATE TABLE book (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE line (book_id INTEGER, idx INTEGER, data BLOB);")
    for b in range(2):
        db.execute("INSERT INTO book VALUES (?,?)", (b + 1, TITLES[b]))
        db.executemany("INSERT INTO line VALUES (?,?,?)", [(b + 1, i, encode(t, i)) for i, t in enumerate(book_lines(b))])
    done(db)


def blob_utf16() -> None:
    """UTF-16 bytes in a BLOB: little-endian, with a BOM on even lines and without on odd ones."""
    blob_text("blob-utf16.db", lambda t, i: (b"\xff\xfe" if i % 2 == 0 else b"") + t.encode("utf-16-le"))


def blob_legacy() -> None:
    """Text in the Windows-1255 code page: as BLOBs in `line`, and as TEXT (invalid UTF-8) in `old_line`."""
    db = fresh("legacy-encoding.db")
    db.executescript(
        """
        CREATE TABLE book (id INTEGER PRIMARY KEY, title TEXT);
        CREATE TABLE line (book_id INTEGER, idx INTEGER, data BLOB);
        CREATE TABLE old_line (book_id INTEGER, idx INTEGER, txt TEXT);
        """
    )
    db.execute("INSERT INTO book VALUES (1, ?)", (TITLES[0],))
    for i, t in enumerate(book_lines(0)):
        raw = t.encode("cp1255")
        db.execute("INSERT INTO line VALUES (1, ?, ?)", (i, raw))
        db.execute("INSERT INTO old_line VALUES (1, ?, CAST(? AS TEXT))", (i, raw))
    done(db)


def chunked() -> None:
    """chunks(book_id, part, data): each book's text (lines joined by newlines) cut every 60
    characters, so a chunk ends in the middle of a line or a word."""
    db = fresh("chunked.db")
    db.executescript("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE chunks (book_id INTEGER, part INTEGER, data TEXT, PRIMARY KEY (book_id, part));")
    for b in range(2):
        db.execute("INSERT INTO books VALUES (?,?)", (b + 1, TITLES[b]))
        text = "\n".join(book_lines(b, 10))
        parts = [text[i : i + 60] for i in range(0, len(text), 60)]
        db.executemany("INSERT INTO chunks VALUES (?,?,?)", [(b + 1, p, s) for p, s in enumerate(parts)])
    done(db)


def composite_key() -> None:
    """Lines keyed by (book_id, chapter, verse): a WITHOUT ROWID table, and a rowid table with the
    same key whose rows were inserted out of order."""
    db = fresh("composite-key.db")
    db.executescript(
        """
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);
        CREATE TABLE verses (book_id INTEGER, chapter INTEGER, verse INTEGER, text TEXT, PRIMARY KEY (book_id, chapter, verse)) WITHOUT ROWID;
        """
    )
    for b in range(2):
        db.execute("INSERT INTO books VALUES (?,?)", (b + 1, TITLES[b]))
        db.executemany("INSERT INTO verses VALUES (?,?,?,?)", [(b + 1, c, v, f"{c}:{v} {sentence(b * 50 + c * 5 + v)}") for c in (1, 2) for v in (1, 2, 3)])
    done(db)
    db = fresh("composite-key-rowid.db")
    db.executescript(
        """
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);
        CREATE TABLE verses (book_id INTEGER, chapter INTEGER, verse INTEGER, text TEXT, PRIMARY KEY (book_id, chapter, verse));
        """
    )
    for b in range(2):
        db.execute("INSERT INTO books VALUES (?,?)", (b + 1, TITLES[b]))
    rows = [(b + 1, c, v, f"{c}:{v} {sentence(b * 50 + c * 5 + v)}") for b in range(2) for c in (1, 2) for v in (1, 2, 3)]
    rows.sort(key=lambda r: (r[2] * 5 + r[1] * 3) % 7)
    db.executemany("INSERT INTO verses VALUES (?,?,?,?)", rows)
    done(db)


def links_table() -> None:
    """books + lines + links(source_line_id, target_line_id, type) by line id, and a second table of
    references by (book, line number), which needs no line ids."""
    db = fresh("links-table.db")
    db.executescript(
        """
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);
        CREATE TABLE lines (id INTEGER PRIMARY KEY, book_id INTEGER, line_no INTEGER, text TEXT);
        CREATE TABLE links (id INTEGER PRIMARY KEY, source_line_id INTEGER, target_line_id INTEGER, type TEXT);
        CREATE TABLE cross_refs (from_book INTEGER, from_line INTEGER, to_book INTEGER, to_line INTEGER);
        """
    )
    ids = {}
    for b in range(2):
        db.execute("INSERT INTO books VALUES (?,?)", (b + 1, TITLES[b]))
        for i, t in enumerate(book_lines(b)):
            ids[(b, i)] = db.execute("INSERT INTO lines (book_id, line_no, text) VALUES (?,?,?)", (b + 1, i, t)).lastrowid
    db.executemany("INSERT INTO links (source_line_id, target_line_id, type) VALUES (?,?,?)", [(ids[(1, i)], ids[(0, i)], "commentary") for i in (1, 2, 4)])
    db.executemany("INSERT INTO cross_refs VALUES (?,?,?,?)", [(2, i, 1, i) for i in (1, 2, 4)])
    done(db)


def versions() -> None:
    """books → versions(book_id, name) → lines(version_id, idx, text): two versions of each book."""
    db = fresh("versions.db")
    db.executescript(
        """
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);
        CREATE TABLE versions (id INTEGER PRIMARY KEY, book_id INTEGER, name TEXT);
        CREATE TABLE lines (version_id INTEGER, idx INTEGER, text TEXT);
        """
    )
    v = 0
    for b in range(2):
        db.execute("INSERT INTO books VALUES (?,?)", (b + 1, TITLES[b]))
        for name in ("דפוס ראשון", "מהדורה מתוקנת"):
            v += 1
            db.execute("INSERT INTO versions VALUES (?,?,?)", (v, b + 1, name))
            db.executemany("INSERT INTO lines VALUES (?,?,?)", [(v, i, t + (" (מתוקן)" if v % 2 == 0 and i == 2 else "")) for i, t in enumerate(book_lines(b))])
    done(db)


def toc_table() -> None:
    """books + lines (no heading markup at all) + toc(book_id, line_idx, level, title)."""
    db = fresh("toc-table.db")
    db.executescript(
        """
        CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);
        CREATE TABLE lines (book_id INTEGER, idx INTEGER, text TEXT);
        CREATE TABLE toc (book_id INTEGER, line_idx INTEGER, level INTEGER, title TEXT);
        """
    )
    for b in range(2):
        db.execute("INSERT INTO books VALUES (?,?)", (b + 1, TITLES[b]))
        db.executemany("INSERT INTO lines VALUES (?,?,?)", [(b + 1, i, sentence(b * 50 + i)) for i in range(8)])
        db.executemany("INSERT INTO toc VALUES (?,?,?,?)", [(b + 1, 0, 1, "פתיחה"), (b + 1, 4, 2, "פרק ב")])
    done(db)


def compressed() -> None:
    """Line text as zlib and as zstd (no dictionary) BLOBs, one database each."""
    blob_text("zlib.db", lambda t, i: zlib.compress(t.encode("utf-8")))
    if zstd is not None:
        blob_text("zstd.db", lambda t, i: zstd.compress(t.encode("utf-8")))


def utf16_database() -> None:
    """A database file whose text encoding is UTF-16le (header offset 56 = 2): books + lines."""
    db = fresh("utf16-database.db", "UTF-16le")
    db.executescript("CREATE TABLE book (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE line (book_id INTEGER, idx INTEGER, content TEXT);")
    for b in range(2):
        db.execute("INSERT INTO book VALUES (?,?)", (b + 1, TITLES[b]))
        db.executemany("INSERT INTO line VALUES (?,?,?)", [(b + 1, i, t) for i, t in enumerate(book_lines(b))])
    done(db)


# ---------------------------------------------------------------- shapes without books


def settings_log() -> None:
    """An application's own database: settings(key, value) and log(ts, level, message) — the log
    messages are text (some Hebrew), but no book."""
    db = fresh("settings-log.db")
    db.executescript(
        """
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE log (id INTEGER PRIMARY KEY, ts TEXT, level TEXT, message TEXT);
        """
    )
    db.executemany("INSERT INTO settings VALUES (?,?)", [("theme", "dark"), ("font_size", "18"), ("last_book", "בראשית"), ("library_path", "C:\\otzaria\\books")])
    msgs = ["הספרייה נטענה בהצלחה", "Search index opened", "שגיאה בטעינת הספר", "Sync finished: 0 changes", "המשתמש פתח ספר"]
    db.executemany("INSERT INTO log (ts, level, message) VALUES (?,?,?)", [(f"2026-11-0{1 + i % 9}T10:{i:02d}:00", "INFO" if i % 3 else "ERROR", msgs[i % len(msgs)]) for i in range(40)])
    done(db)


def fts_only() -> None:
    """An FTS5 search index and nothing else: contentless (no text at all), and a regular one (the
    text sits in its internal table docs_content)."""
    db = fresh("fts-contentless.db")
    db.execute("CREATE VIRTUAL TABLE search USING fts5(title, body, content='')")
    for b in range(2):
        db.executemany("INSERT INTO search (rowid, title, body) VALUES (?,?,?)", [(b * 100 + i, TITLES[b], t) for i, t in enumerate(book_lines(b))])
    done(db)
    db = fresh("fts-stored.db")
    db.execute("CREATE VIRTUAL TABLE docs USING fts5(title, body)")
    for b in range(2):
        db.executemany("INSERT INTO docs (title, body) VALUES (?,?)", [(TITLES[b], t) for t in book_lines(b)])
    done(db)


def views_only() -> None:
    """Books exist only through views: an entity/attribute table kv(entity, attr, val) and views
    v_books / v_lines that assemble them. The reader reads b-trees, not views."""
    db = fresh("views-only.db")
    db.executescript(
        """
        CREATE TABLE kv (entity INTEGER, attr TEXT, val TEXT);
        CREATE VIEW v_books AS SELECT entity AS id, val AS title FROM kv WHERE attr = 'title';
        CREATE VIEW v_lines AS SELECT entity / 1000 AS book_id, entity % 1000 AS idx, val AS text FROM kv WHERE attr = 'line';
        """
    )
    for b in range(2):
        db.execute("INSERT INTO kv VALUES (?, 'title', ?)", (b + 1, TITLES[b]))
        db.executemany("INSERT INTO kv VALUES (?, 'line', ?)", [((b + 1) * 1000 + i, t) for i, t in enumerate(book_lines(b))])
    done(db)


def catalog() -> None:
    """A library catalog: one row per book with its details (authors as a JSON list, year, place,
    pages, subjects) — book names and Hebrew text, but no book text at all. Shaped after a real
    catalog database seen in the audit (otzar-HB_catalog.db: column kinds only, no data copied)."""
    db = fresh("catalog.db")
    db.execute("CREATE TABLE catalog (book_id INTEGER PRIMARY KEY, title TEXT, authors TEXT, from_year TEXT, places TEXT, subjects TEXT, pages INTEGER)")
    names = ["רבי משה בן מימון", "רבי יוסף קארו", "רבי שלמה יצחקי", "רבי יעקב בן אשר"]
    places = ["ונציה", "אמשטרדם", "וילנה", "ירושלים"]
    rows = []
    for i in range(20):
        authors = json.dumps([names[i % 4]] + ([names[(i + 1) % 4]] if i % 3 == 0 else []), ensure_ascii=False)
        rows.append((i + 1, f"{TITLES[i % 3]} כרך {'אבגד'[i % 4]}", authors, str(1500 + i * 17), places[i % 4], "הלכה; מנהגים" if i % 2 else "פרשנות המקרא", 100 + i * 13))
    db.executemany("INSERT INTO catalog VALUES (?,?,?,?,?,?,?)", rows)
    done(db)


def empty_tables() -> None:
    """The schema of a books database, with no rows at all."""
    db = fresh("empty-tables.db")
    db.executescript("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT); CREATE TABLE lines (book_id INTEGER, idx INTEGER, text TEXT);")
    done(db)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith(".db"):
            os.remove(os.path.join(OUT, f))
    book_per_row()
    line_per_row()
    books_lines_fk()
    books_lines_nofk()
    json_chapters()
    chapters_lines()
    blob_text("blob-utf8.db", lambda t, i: t.encode("utf-8"))
    blob_utf16()
    blob_legacy()
    compressed()
    chunked()
    composite_key()
    links_table()
    versions()
    toc_table()
    utf16_database()
    settings_log()
    fts_only()
    views_only()
    catalog()
    empty_tables()
    total = 0
    for name in sorted(os.listdir(OUT)):
        size = os.path.getsize(os.path.join(OUT, name))
        total += size
        print(f"{name:28} {size:7}")
    print(f"{'total':28} {total:7}")


if __name__ == "__main__":
    main()
