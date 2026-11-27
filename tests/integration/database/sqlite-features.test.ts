import type { Database, SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { mappingProblems, ROWID, type DbMapping } from "../../../src/core/db-mapping";
import { MappedDbReader } from "../../../src/database/generic/mapped-reader";
import { previewSchema } from "../../../src/database/generic/preview";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { SqliteFile } from "../../../src/database/sqlite/lazy/sqlite-file";
import { loadSqlJs } from "../../support/sql-js";

/*
 * Review C12: SQLite features a foreign (mapped) database may use, and the lazy reader used to get
 * wrong — silently, rows or whole books disappeared. Every case is checked against SQLite itself
 * (sql.js): either the reader returns exactly what SQLite returns, or it refuses with a Hebrew
 * message. It must never return fewer rows.
 */
let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await loadSqlJs();
});

function build(sql: string, encoding?: "UTF-16le" | "UTF-16be"): Database {
  const db = new SQL.Database();
  if (encoding) db.run(`PRAGMA encoding = '${encoding}'`);
  db.run(sql);
  return db;
}
const open = (db: Database) => SqliteFile.open(bytesSource(db.export()));
const rows = (db: Database, sql: string) => db.exec(sql)[0]?.values ?? [];

/* ---------------- index metadata, against SQLite's own PRAGMAs ---------------- */

const SCHEMAS = `
CREATE TABLE t1 (uid TEXT UNIQUE, book INT, ord INT, body TEXT, PRIMARY KEY (book, ord));
CREATE TABLE t2 (a INT PRIMARY KEY, b TEXT UNIQUE);
CREATE TABLE t3 (a INTEGER PRIMARY KEY, b UNIQUE, c, UNIQUE (c, b));
CREATE TABLE t4 (a, b, UNIQUE (a), UNIQUE (A), PRIMARY KEY (a));
CREATE TABLE t5 (a TEXT COLLATE NOCASE UNIQUE, b TEXT, UNIQUE (b COLLATE NOCASE), UNIQUE (b DESC), UNIQUE (b COLLATE binary));
CREATE TABLE t6 (a, b, c, PRIMARY KEY (a, b), UNIQUE (c), UNIQUE (b, a)) WITHOUT ROWID;
CREATE TABLE t7 (a INTEGER PRIMARY KEY DESC, b UNIQUE);
CREATE TABLE t8 (a INTEGER, b UNIQUE, PRIMARY KEY (a DESC));
CREATE TABLE t9 (x TEXT UNIQUE ON CONFLICT REPLACE, y TEXT CONSTRAINT u UNIQUE, z TEXT NOT NULL UNIQUE, w TEXT COLLATE RTRIM UNIQUE);
CREATE TABLE t10 ("quoted, col" TEXT UNIQUE, [br] INT, PRIMARY KEY ([br]));
CREATE TABLE t11 (a TEXT PRIMARY KEY, UNIQUE (a));
CREATE TABLE t12 (a TEXT UNIQUE, b, PRIMARY KEY (a));
CREATE TABLE t13 (a, b, UNIQUE (a, b), PRIMARY KEY (b, a));
CREATE TABLE t14 (a TEXT PRIMARY KEY COLLATE NOCASE UNIQUE, b);
CREATE TABLE t15 (a TEXT, b TEXT, CONSTRAINT pk PRIMARY KEY (a COLLATE NOCASE, b), CONSTRAINT uq UNIQUE (a, b));
CREATE INDEX i1 ON t1 (book COLLATE NOCASE);
CREATE INDEX i2 ON t5 (a);
CREATE INDEX i3 ON t5 (a COLLATE BINARY, b);
CREATE INDEX i4 ON t1 (book) WHERE ord > 0;
CREATE UNIQUE INDEX i5 ON t1 (body, ord DESC);
CREATE INDEX i6 ON t1 (lower(body));
CREATE INDEX i7 ON t1 (book, ord ASC);
CREATE INDEX i8 ON t9 (w, x);
`;

describe("index metadata matches SQLite (review C12)", () => {
  it("every index's key columns and seekability, including sqlite_autoindex numbering", async () => {
    const db = build(SCHEMAS);
    const file = await open(db);
    const tables = rows(db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => String(r[0]));
    const want: Record<string, { columns: string[]; seekable: boolean }> = {};
    const got: Record<string, { columns: string[]; seekable: boolean }> = {};
    for (const t of tables) {
      const inMaster = new Set(rows(db, `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '${t}'`).map((r) => String(r[0])));
      for (const [, name, , , partial] of rows(db, `PRAGMA index_list("${t}")`)) {
        if (!inMaster.has(String(name))) continue; // the primary key of a WITHOUT ROWID table is the table itself
        const keys = rows(db, `PRAGMA index_xinfo("${name}")`).filter((r) => r[5] === 1); // seqno, cid, name, desc, coll, key
        want[String(name)] = {
          columns: keys.map((r) => (r[1] === -2 ? "<expr>" : String(r[2]))),
          seekable: partial === 0 && keys.every((r) => r[1] !== -2 && r[3] === 0 && String(r[4]).toUpperCase() === "BINARY"),
        };
      }
      for (const ix of await file.indexesOf(t)) got[ix.name] = { columns: ix.columns, seekable: ix.seekable };
    }
    // an expression key has no column name: the reader keeps a placeholder, and never seeks it
    for (const [name, w] of Object.entries(want)) if (w.columns.includes("<expr>") && got[name]) got[name].columns = w.columns;
    expect(Object.keys(want).filter((n) => n.startsWith("sqlite_autoindex_"))).toHaveLength(28);
    expect(got).toEqual(want);
  });

  it("a WITHOUT ROWID table whose key is not BINARY/ASC is not seekable by key", async () => {
    const db = build(`
      CREATE TABLE w1 (book TEXT, ord INT, body TEXT, PRIMARY KEY (book, ord)) WITHOUT ROWID;
      CREATE TABLE w2 (book TEXT COLLATE NOCASE, ord INT, body TEXT, PRIMARY KEY (book, ord)) WITHOUT ROWID;
      CREATE TABLE w3 (book TEXT, ord INT, body TEXT, PRIMARY KEY (book, ord DESC)) WITHOUT ROWID;
      CREATE TABLE w4 (book TEXT PRIMARY KEY COLLATE NOCASE, body TEXT) WITHOUT ROWID;
      CREATE TABLE w5 (book TEXT, ord INT, body TEXT, PRIMARY KEY (book COLLATE rtrim, ord)) WITHOUT ROWID;`);
    const file = await open(db);
    const seekable = await Promise.all(["w1", "w2", "w3", "w4", "w5"].map(async (t) => (await file.table(t))!.primaryKeySeekable));
    expect(seekable).toEqual([true, false, false, false, false]);
  });
});

/* ---------------- reading through a mapping: the five cases of the review ---------------- */

const SINGLE: DbMapping = { layout: "single-table", lines: { table: "t", book: "book", order: "ord", text: "body" } };

/** Every book with its lines, read through the mapping. */
async function readAll(file: SqliteFile, m: DbMapping): Promise<Record<string, string[]>> {
  const r = await MappedDbReader.open(file, m);
  const out: Record<string, string[]> = {};
  for (const b of r.books) out[b.title] = (await r.lines(b.n)).map((l) => l.text);
  return out;
}
/** The same from SQLite: [book, body] rows, grouped. */
function sqlAll(db: Database, sql: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [book, body] of rows(db, sql)) (out[String(book)] ??= []).push(String(body));
  return out;
}

describe("mapped databases read exactly what SQLite reads (review C12)", () => {
  it("R1: a COLLATE NOCASE book column with an index on (book, ord)", async () => {
    const db = build(`
      CREATE TABLE t (book TEXT COLLATE NOCASE, ord INTEGER, body TEXT);
      CREATE INDEX t_book ON t (book, ord);
      INSERT INTO t VALUES ('B', 2, 'b2'), ('a', 1, 'a1'), ('B', 1, 'b1'), ('A', 3, 'A3'), ('b', 5, 'lower b5');`);
    const got = await readAll(await open(db), SINGLE);
    expect(got).toEqual(sqlAll(db, "SELECT book, body FROM t ORDER BY book COLLATE BINARY, ord"));
    expect(got.B).toEqual(["b1", "b2"]);
  });

  it("R1b: a two-table mapping over a NOCASE index reads every line of every book", async () => {
    const db = build(`
      CREATE TABLE books (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE lines (book TEXT COLLATE NOCASE, ord INTEGER, body TEXT);
      CREATE INDEX lines_book ON lines (book, ord);
      INSERT INTO books VALUES ('B', 'ספר ב'), ('a', 'ספר א');
      INSERT INTO lines VALUES ('B', 2, 'b2'), ('a', 1, 'a1'), ('B', 1, 'b1');`);
    const m: DbMapping = { layout: "two-tables", books: { table: "books", id: "id", title: "title" }, lines: { table: "lines", book: "book", order: "ord", text: "body" } };
    expect(await readAll(await open(db), m)).toEqual({ "ספר ב": ["b1", "b2"], "ספר א": ["a1"] });
  });

  it("R2: a partial index (WHERE level IS NULL) is not used to find a book's lines", async () => {
    const db = build(`
      CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);
      CREATE TABLE lines (book INTEGER, ord INTEGER, level INTEGER, body TEXT);
      CREATE INDEX body_lines ON lines (book, ord) WHERE level IS NULL;
      INSERT INTO books VALUES (1, 'ספר');
      INSERT INTO lines VALUES (1, 0, 1, '<h1>כותרת</h1>'), (1, 1, NULL, 'שורה א'), (1, 2, NULL, 'שורה ב');`);
    const m: DbMapping = { layout: "two-tables", books: { table: "books", id: "id", title: "title" }, lines: { table: "lines", book: "book", order: "ord", text: "body", heading: "level" } };
    expect(await readAll(await open(db), m)).toEqual({ ספר: ["<h1>כותרת</h1>", "שורה א", "שורה ב"] });
  });

  it("R3: UNIQUE before PRIMARY KEY (book, ord): sqlite_autoindex_1 is the UNIQUE one", async () => {
    const db = build(`
      CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT);
      CREATE TABLE lines (uid TEXT UNIQUE, book INTEGER, ord INTEGER, body TEXT, PRIMARY KEY (book, ord));
      INSERT INTO books VALUES (1, 'א'), (2, 'ב');
      INSERT INTO lines VALUES ('u3', 2, 1, 'ב1'), ('u1', 1, 2, 'א2'), ('u2', 1, 1, 'א1');`);
    const m: DbMapping = { layout: "two-tables", books: { table: "books", id: "id", title: "title" }, lines: { table: "lines", book: "book", order: "ord", text: "body" } };
    const r = await MappedDbReader.open(await open(db), m);
    expect(r.strategy).toBe("index"); // the PRIMARY KEY's own index (autoindex_2) is found and used
    expect(await readAll(await open(db), m)).toEqual({ א: ["א1", "א2"], ב: ["ב1"] });
  });

  const KEYS = `INSERT INTO t VALUES ('é', 1, 'e1'), ('א', 2, 'alef2'), ('z', 1, 'z1'), ('א', 1, 'alef1'), ('é', 0, 'e0'), ('😀', 1, 'emoji'), ('ﬀ', 1, 'ff');`;

  it.each(["UTF-16le", "UTF-16be"] as const)("R4: a %s database with text book keys", async (encoding) => {
    const db = build(`CREATE TABLE t (book TEXT, ord INTEGER, body TEXT); CREATE INDEX t_book ON t (book, ord); ${KEYS}`, encoding);
    const file = await open(db);
    expect(file.header.encoding).toBe(encoding === "UTF-16le" ? 2 : 3);
    const want = sqlAll(db, "SELECT book, body FROM t ORDER BY book, ord");
    expect(await readAll(file, SINGLE)).toEqual(want);
    const db2 = build(`CREATE TABLE b (id TEXT); INSERT INTO b VALUES ('é'), ('א'), ('z'), ('😀'), ('ﬀ');
      CREATE TABLE t (book TEXT, ord INTEGER, body TEXT); CREATE INDEX t_book ON t (book, ord); ${KEYS}`, encoding);
    const two: DbMapping = { layout: "two-tables", books: { table: "b", id: "id", title: "id" }, lines: { table: "t", book: "book", order: "ord", text: "body" } };
    expect((await MappedDbReader.open(await open(db2), two)).strategy).toBe("index"); // seeks, one book at a time
    expect(await readAll(await open(db2), two)).toEqual(want);
  });

  it.each(["UTF-16le", "UTF-16be"] as const)("R4b: a %s WITHOUT ROWID lines table, read by primary key", async (encoding) => {
    const db = build(`CREATE TABLE b (id TEXT); INSERT INTO b VALUES ('é'), ('א'), ('z'), ('😀'), ('ﬀ');
      CREATE TABLE t (book TEXT, ord INTEGER, body TEXT, PRIMARY KEY (book, ord)) WITHOUT ROWID; ${KEYS}`, encoding);
    const m: DbMapping = { layout: "two-tables", books: { table: "b", id: "id", title: "id" }, lines: { table: "t", book: "book", order: "ord", text: "body" } };
    expect(await readAll(await open(db), m)).toEqual(sqlAll(db, "SELECT book, body FROM t ORDER BY book, ord"));
  });

  it("R5: GENERATED columns — STORED ones are read, a VIRTUAL one does not shift the others", async () => {
    const db = build(`
      CREATE TABLE t (book INTEGER, ord INTEGER, nxt INTEGER GENERATED ALWAYS AS (ord + 1) VIRTUAL, label TEXT AS ('#' || ord) STORED, body TEXT, tail TEXT AS (upper(body)));
      INSERT INTO t (book, ord, body) VALUES (1, 1, 'hello'), (1, 2, 'world');`);
    const file = await open(db);
    const t = (await file.table("t"))!;
    expect(t.columns.map((c) => [c.name, c.generated])).toEqual([["book", null], ["ord", null], ["nxt", "virtual"], ["label", "stored"], ["body", null], ["tail", "virtual"]]);
    const got: unknown[][] = [];
    for await (const r of file.scan(t)) got.push(r.values);
    // a VIRTUAL value is not in the file: null; every stored column is in its place
    expect(got).toEqual(rows(db, "SELECT book, ord, NULL, label, body, NULL FROM t"));
    expect(await readAll(file, SINGLE)).toEqual({ 1: ["hello", "world"] });
  });

  it("R5b: mapping a VIRTUAL column is refused, in the wizard and by the reader", async () => {
    const db = build(`
      CREATE TABLE t (book INTEGER, ord INTEGER, body TEXT, shown TEXT AS ('<b>' || body || '</b>') VIRTUAL);
      INSERT INTO t (book, ord, body) VALUES (1, 1, 'hello');`);
    const file = await open(db);
    const m: DbMapping = { layout: "single-table", lines: { table: "t", book: "book", order: "ord", text: "shown" } };
    const p = await previewSchema(file);
    expect(mappingProblems(p, m).filter((x) => x.level === "error").map((x) => x.message).join(" ")).toMatch(/מחושבת/);
    await expect(MappedDbReader.open(file, m)).rejects.toMatchObject({ code: "db/mapping-invalid", message: expect.stringMatching(/מחושבת/) });
  });

  it("a WITHOUT ROWID lines table with a NOCASE key is refused with a Hebrew message, not read wrong", async () => {
    const db = build(`
      CREATE TABLE t (book TEXT COLLATE NOCASE, ord INTEGER, body TEXT, PRIMARY KEY (book, ord)) WITHOUT ROWID;
      INSERT INTO t VALUES ('B', 1, 'b1'), ('a', 1, 'a1');`);
    const file = await open(db);
    await expect(MappedDbReader.open(file, SINGLE)).rejects.toMatchObject({ code: "db/mapping-invalid", message: expect.stringMatching(/NOCASE|DESC/) });
    expect(mappingProblems(await previewSchema(file), SINGLE).filter((x) => x.level === "error").length).toBeGreaterThan(0);
  });

  it("ROWID order over a NOCASE (book) index still finds every line", async () => {
    const db = build(`
      CREATE TABLE t (book TEXT COLLATE NOCASE, body TEXT);
      CREATE INDEX t_book ON t (book);
      INSERT INTO t VALUES ('B', 'b1'), ('a', 'a1'), ('b', 'lower b'), ('B', 'b2');`);
    const m: DbMapping = { layout: "single-table", lines: { table: "t", book: "book", order: ROWID, text: "body" } };
    expect(await readAll(await open(db), m)).toEqual(sqlAll(db, "SELECT book, body FROM t ORDER BY book COLLATE BINARY, rowid"));
  });
});
