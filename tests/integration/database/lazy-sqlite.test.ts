import { createRequire } from "node:module";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { parseCreateTable } from "../../../src/database/sqlite/lazy/ddl";
import type { SqlValue } from "../../../src/database/sqlite/lazy/record";
import { SqliteFile, SqliteFormatError } from "../../../src/database/sqlite/lazy/sqlite-file";

/*
 * The lazy reader is checked against SQLite itself (sql.js): the same file, read both ways, must
 * give identical rows. Databases are generated with several page sizes and both text encodings,
 * enough rows for multi-level b-trees, and payloads large enough to spill into overflow pages.
 */
const require = createRequire(import.meta.url);
let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
});

// The comments contain commas on purpose: v3 split on them and renamed columns (TD-H5).
const LINE_DDL = `CREATE TABLE line (
  id INTEGER PRIMARY KEY, -- rowid alias, stored as NULL in the record
  bookId INTEGER NOT NULL, /* the book, owner */
  lineIndex INTEGER NOT NULL, -- 0-based, per book
  content TEXT, -- may be large, e.g. a whole page
  data BLOB,
  score REAL,
  big INTEGER
)`;

let seed = 42;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const heb = (len: number) => Array.from({ length: len }, () => "אבגדהוזחטיכלמנסעפצקרשת "[rnd(23)]).join("");

function buildDb(pageSize: number, encoding: "UTF-8" | "UTF-16le" | "UTF-16be"): { db: Database; bytes: Uint8Array } {
  const db = new SQL.Database();
  db.run(`PRAGMA page_size = ${pageSize}; PRAGMA encoding = '${encoding}';`);
  db.run(LINE_DDL);
  db.run("CREATE INDEX idx_line_book_index ON line(bookId, lineIndex)");
  db.run("CREATE TABLE line_note (lineId INTEGER NOT NULL, noteIndex INTEGER NOT NULL, content TEXT, PRIMARY KEY (lineId, noteIndex)) WITHOUT ROWID");
  const ins = db.prepare("INSERT INTO line (id, bookId, lineIndex, content, data, score, big) VALUES (?,?,?,?,?,?,?)");
  const bigs: (number | bigint | null)[] = [0, -1, 127, -129, 32767, 8388607, -8388608, 2 ** 31, -(2 ** 40), 2 ** 47 - 1, 2 ** 53 - 1, null];
  // rowids are deliberately scattered, like seforim.db (TD-H6)
  for (let i = 0; i < 1500; i++) {
    const book = 1 + rnd(7);
    const len = i % 97 === 0 ? 5000 + rnd(120000) : rnd(300);
    ins.run([i * 7 + rnd(5) + 1 + i * 3, book, rnd(400), len ? heb(len) : null, i % 5 === 0 ? new Uint8Array([i & 255, 0, 255]) : null, i % 3 ? i / 7 : null, bigs[i % bigs.length] as number]);
  }
  ins.free();
  const note = db.prepare("INSERT OR IGNORE INTO line_note VALUES (?,?,?)");
  for (let i = 0; i < 400; i++) note.run([1 + rnd(60), rnd(5), heb(5 + rnd(i % 50 === 0 ? 9000 : 40))]);
  note.free();
  db.run("ALTER TABLE line ADD COLUMN status TEXT DEFAULT 'פעיל'");
  db.run("INSERT INTO line (id, bookId, lineIndex, content, status) VALUES (999999, 3, 7, 'אחרון', 'חדש')");
  return { db, bytes: db.export() };
}

const rowsOf = (db: Database, sql: string): SqlValue[][] => (db.exec(sql)[0]?.values ?? []) as SqlValue[][];
const norm = (v: SqlValue) => (v instanceof Uint8Array ? Array.from(v) : typeof v === "bigint" ? Number(v) : v);
const normRows = (rows: SqlValue[][]) => rows.map((r) => r.map(norm));

describe.each([
  [512, "UTF-8"],
  [1024, "UTF-16le"],
  [4096, "UTF-16be"],
  [65536, "UTF-8"],
] as const)("lazy reader vs SQLite — page size %i, %s", (pageSize, encoding) => {
  let db: Database;
  let file: SqliteFile;
  beforeAll(async () => {
    const built = buildDb(pageSize, encoding);
    db = built.db;
    file = await SqliteFile.open(bytesSource(built.bytes));
  });

  it("reads the header", () => {
    expect(file.header.pageSize).toBe(pageSize);
    expect(file.header.encoding).toBe(encoding === "UTF-8" ? 1 : encoding === "UTF-16le" ? 2 : 3);
    expect(file.header.wal).toBe(false);
  });

  it("parses column names despite commas inside comments (TD-H5)", async () => {
    const t = (await file.table("line"))!;
    expect(t.columns.map((c) => c.name)).toEqual(["id", "bookId", "lineIndex", "content", "data", "score", "big", "status"]);
    expect(t.columns[0]!.rowidAlias).toBe(true);
  });

  it("full scan equals SELECT * ORDER BY rowid (overflow, alias, ALTER TABLE default)", async () => {
    const t = (await file.table("line"))!;
    const got: SqlValue[][] = [];
    for await (const r of file.scan(t)) got.push(r.values);
    expect(normRows(got)).toEqual(normRows(rowsOf(db, "SELECT * FROM line ORDER BY rowid")));
  });

  it("rowid lookup and rowid range", async () => {
    const t = (await file.table("line"))!;
    const ids = rowsOf(db, "SELECT id FROM line ORDER BY random() LIMIT 25").map((r) => r[0] as number);
    for (const id of ids) {
      const r = await file.get(t, id);
      expect(normRows([r!.values])).toEqual(normRows(rowsOf(db, `SELECT * FROM line WHERE id = ${id}`)));
    }
    expect(await file.get(t, 123456789)).toBeNull();
    const got: number[] = [];
    for await (const r of file.scan(t, { from: 500, to: 2000 })) got.push(r.rowid!);
    expect(got).toEqual(rowsOf(db, "SELECT id FROM line WHERE id BETWEEN 500 AND 2000 ORDER BY id").map((r) => r[0]));
  });

  it("index seek returns (bookId, lineIndex, rowid) in index order, without touching the table (TD-H6)", async () => {
    const [ix] = await file.indexesOf("line");
    expect(ix).toMatchObject({ name: "idx_line_book_index", columns: ["bookId", "lineIndex"], seekable: true });
    for (const book of [1, 3, 7, 8]) {
      const got: SqlValue[][] = [];
      for await (const rec of file.seekIndex(ix!, [book])) got.push(rec);
      expect(got).toEqual(rowsOf(db, `SELECT bookId, lineIndex, id FROM line WHERE bookId = ${book} ORDER BY lineIndex, id`));
    }
    const two: SqlValue[][] = [];
    for await (const rec of file.seekIndex(ix!, [3, 7])) two.push(rec);
    expect(two).toEqual(rowsOf(db, "SELECT bookId, lineIndex, id FROM line WHERE bookId = 3 AND lineIndex = 7 ORDER BY id"));
  });

  it("WITHOUT ROWID table: scan and primary-key prefix seek, columns in declared order", async () => {
    const t = (await file.table("line_note"))!;
    expect(t.withoutRowid).toBe(true);
    expect(t.primaryKey).toEqual(["lineId", "noteIndex"]);
    const all: SqlValue[][] = [];
    for await (const r of file.scan(t)) all.push(r.values);
    expect(all).toEqual(rowsOf(db, "SELECT lineId, noteIndex, content FROM line_note ORDER BY lineId, noteIndex"));
    const some: SqlValue[][] = [];
    for await (const r of file.seekPrimaryKey(t, [5])) some.push(r.values);
    expect(some).toEqual(rowsOf(db, "SELECT lineId, noteIndex, content FROM line_note WHERE lineId = 5 ORDER BY noteIndex"));
  });
});

describe("lazy reader — reads only what a seek needs", () => {
  it("a book's lines via the index touch a small fraction of the pages", async () => {
    const db = new SQL.Database();
    db.run("PRAGMA page_size = 4096");
    db.run(LINE_DDL);
    db.run("CREATE INDEX idx_line_book_index ON line(bookId, lineIndex)");
    db.run("BEGIN");
    const ins = db.prepare("INSERT INTO line (bookId, lineIndex, content) VALUES (?,?,?)");
    for (let i = 0; i < 40000; i++) ins.run([i % 400, Math.floor(i / 400), "שורה " + i]);
    ins.free();
    db.run("COMMIT");
    const file = await SqliteFile.open(bytesSource(db.export()));
    const [ix] = await file.indexesOf("line");
    const before = file.pagesRead;
    let n = 0;
    for await (const _ of file.seekIndex(ix!, [123])) n++;
    expect(n).toBe(100);
    expect(file.pagesRead - before).toBeLessThan(file.header.pageCount / 20);
  });
});

describe("lazy reader — damaged input", () => {
  it("rejects a non-SQLite file and a truncated database with a format error", async () => {
    await expect(SqliteFile.open(bytesSource(new Uint8Array(4096)))).rejects.toBeInstanceOf(SqliteFormatError);
    const { bytes } = buildDb(1024, "UTF-8");
    const file = await SqliteFile.open(bytesSource(bytes.subarray(0, bytes.length >> 1)));
    const t = (await file.table("line"))!;
    await expect((async () => { for await (const _ of file.scan(t)); })()).rejects.toBeInstanceOf(SqliteFormatError);
  });
});

describe("parseCreateTable", () => {
  it("table-level PRIMARY KEY on one INTEGER column is a rowid alias; quoted names and constraints", () => {
    const t = parseCreateTable(`CREATE TABLE "x y" ("primary" TEXT, [id] INTEGER, 'q' TEXT DEFAULT 'a,b', CONSTRAINT pk PRIMARY KEY (id), UNIQUE (q), CHECK (id > 0), FOREIGN KEY (q) REFERENCES z(w))`);
    expect(t.columns.map((c) => [c.name, c.type, c.rowidAlias, c.defaultValue])).toEqual([
      ["primary", "TEXT", false, null],
      ["id", "INTEGER", true, null],
      ["q", "TEXT", false, "a,b"],
    ]);
    expect(t.primaryKey).toEqual(["id"]);
  });
  it("INTEGER PRIMARY KEY DESC is not a rowid alias (SQLite quirk)", () => {
    expect(parseCreateTable("CREATE TABLE t (id INTEGER PRIMARY KEY DESC, v TEXT)").columns[0]!.rowidAlias).toBe(false);
  });
});
