import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { gzipSync } from "fflate";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { guessMapping, mappingProblems, ROWID, type DbMapping } from "../../../src/core/db-mapping";
import { MappedDbReader } from "../../../src/database/generic/mapped-reader";
import { previewSchema } from "../../../src/database/generic/preview";
import { blobKind, GenericTextCodec } from "../../../src/database/generic/text-codec";
import { bytesSource } from "../../../src/database/sqlite/lazy/byte-source";
import { SqliteFile } from "../../../src/database/sqlite/lazy/sqlite-file";

/*
 * Generic (non-Otzaria) databases read through a mapping: the fixtures of
 * scripts/fixtures/make_generic_dbs.py, plus databases generated here with sql.js for the cases a
 * fixture would make too large (50,000 lines) or that must be corrupted on purpose.
 */
const require = createRequire(import.meta.url);
let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
});

const fixture = (name: string) => SqliteFile.open(bytesSource(new Uint8Array(readFileSync(`tests/fixtures/db/generic/${name}`))));
const texts = async (r: MappedDbReader, n: number, from = 0, to = 1e9) => (await r.lines(n, from, to)).map((l) => l.text);

describe("schema preview and the automatic guess", () => {
  it("books + lines: tables, columns, kinds, samples, and a two-table guess with the links table", async () => {
    const p = await previewSchema(await fixture("books-lines.db"));
    expect(p.tables.map((t) => t.name)).toEqual(["works", "paragraphs", "connections"]);
    const para = p.tables.find((t) => t.name === "paragraphs")!;
    expect(para.columns.map((c) => [c.name, c.kind])).toEqual([["id", "integer"], ["work_id", "integer"], ["seq", "integer"], ["body", "html"], ["level", "integer"]]);
    expect(para.samples.length).toBe(5);
    expect(para.indexes).toEqual([]);
    expect(p.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const g = guessMapping(p)!;
    expect(g).toEqual({
      layout: "two-tables",
      books: { table: "works", id: "id", title: "name", category: "category" },
      lines: { table: "paragraphs", book: "work_id", order: "seq", text: "body", heading: "level" },
      links: { table: "connections", source: "from_line", target: "to_line", type: "kind" },
    });
    const problems = mappingProblems(p, g);
    expect(problems.filter((x) => x.level === "error")).toEqual([]);
    expect(problems.map((x) => x.message).join()).toContain("אין בטבלה \"paragraphs\" אינדקס"); // says a scan is coming
  });

  it("one table per line: guessed as single-table, with the index noticed", async () => {
    const p = await previewSchema(await fixture("single-table.db"));
    const g = guessMapping(p)!;
    expect(g).toMatchObject({ layout: "single-table", lines: { table: "corpus", book: "book_title", order: "line_no", text: "html" } });
    expect(mappingProblems(p, g)).toEqual([]);
  });

  it("compressed BLOB text is recognised and described", async () => {
    const p = await previewSchema(await fixture("compressed.db"));
    const line = p.tables.find((t) => t.name === "line")!;
    expect(line.withoutRowid).toBe(true);
    expect(line.columns.find((c) => c.name === "data")).toMatchObject({ kind: "compressed" });
    expect(p.notes.join(" ")).toMatch(/דחוס/);
    expect(line.samples[0]![2]).not.toMatch(/בתים/); // decoded for display
    expect(guessMapping(p)).toMatchObject({ layout: "two-tables", books: { table: "book", id: "book_id", title: "title" }, lines: { table: "line", book: "book_id", order: "idx", text: "data" } });
  });

  it("a database without text: no guess, and mapping a binary column is an error", async () => {
    const p = await previewSchema(await fixture("no-text.db"));
    expect(guessMapping(p)).toBeNull();
    expect(p.notes.join(" ")).toMatch(/בינאריים/);
    const m: DbMapping = { layout: "single-table", lines: { table: "measurements", book: "sensor", order: ROWID, text: "raw" } };
    expect(mappingProblems(p, m).filter((x) => x.level === "error").map((x) => x.message).join()).toMatch(/בינאריים/);
  });
});

describe("reading through a mapping", () => {
  it("two tables without an index: one scan, lines in `seq` order, headings from the level column, links resolved", async () => {
    const file = await fixture("books-lines.db");
    const m = guessMapping(await previewSchema(file))!;
    const progress: number[] = [];
    const r = await MappedDbReader.open(file, m, { progress: (d) => progress.push(d) });
    expect(r.strategy).toBe("scan");
    expect(r.books.map((b) => [b.title, b.lineCount, b.path])).toEqual([["ספר הדוגמה", 12, "דוגמאות"], ["פירוש על ספר הדוגמה", 6, "פירושים"], ["ספר ריק", 0, null]]);
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["db/mapping-orphan-lines", "db/mapping-links-unresolved"]));
    const lines = await r.lines(0);
    expect(lines.map((l) => l.index)).toEqual([...Array(12).keys()]);
    expect(lines[0]).toMatchObject({ text: "ספר הדוגמה", heading: 1 });
    expect(lines[3]!.text).toMatch(/^<b>/);
    expect(lines.slice(1).every((l) => l.heading === null)).toBe(true);
    expect(await texts(r, 0, 2, 4)).toEqual(lines.slice(2, 5).map((l) => l.text));
    expect(await r.lines(2)).toEqual([]);
    // commentary line N → base line N (two commentary links, one reference; the 4th points nowhere)
    const links = r.linksAt(1, 0, 10);
    expect(links.map((l) => [l.source, l.target, l.type])).toEqual([
      [{ book: 1, line: 1 }, { book: 0, line: 1 }, "commentary"],
      [{ book: 1, line: 2 }, { book: 0, line: 2 }, "commentary"],
      [{ book: 1, line: 3 }, { book: 0, line: 3 }, "reference"],
    ]);
    expect(r.linksAt(0, 2, 2).map((l) => l.source.line)).toEqual([2]);
  });

  it("one table with an index on (title, order): books come from the index, not the table", async () => {
    const file = await fixture("single-table.db");
    const m = guessMapping(await previewSchema(file))!;
    const r = await MappedDbReader.open(file, m);
    expect(r.books.map((b) => [b.title, b.lineCount])).toEqual([["מדרש לדוגמה", 10], ["קובץ שיעורים", 10]]);
    const lines = await r.lines(1);
    expect(lines.map((l) => l.heading)).toEqual([1, 2, null, null, null, null, null, null, null, null]);
    expect(lines[0]!.text).toBe("<h1>קובץ שיעורים</h1>");
    // with a path column the table itself is scanned (the index does not hold it)
    const withPath = await MappedDbReader.open(file, { ...m, lines: { ...m.lines, path: "source_file" } });
    expect(withPath.books[0]!.path).toBe("מדרש לדוגמה.txt");
    expect(await texts(withPath, 1)).toEqual(lines.map((l) => l.text));
  });

  it("WITHOUT ROWID lines with gzip, zlib and plain UTF-8 BLOBs: read lazily by primary key", async () => {
    const file = await fixture("compressed.db");
    const r = await MappedDbReader.open(file, guessMapping(await previewSchema(file))!);
    expect(r.strategy).toBe("index");
    expect(r.books.map((b) => [b.title, b.lineCount])).toEqual([["ספר דחוס", null]]);
    const all = await texts(r, 0);
    expect(all).toHaveLength(9);
    expect(all.every((t) => /^[א-ת ]+$/.test(t))).toBe(true);
    expect(await texts(r, 0, 4, 6)).toEqual(all.slice(4, 7));
    expect(await r.lineCount(0)).toBe(9);
  });

  it("refuses a mapping that names a missing table or column, with a clear message", async () => {
    const file = await fixture("books-lines.db");
    const m = guessMapping(await previewSchema(file))!;
    await expect(MappedDbReader.open(file, { ...m, lines: { ...m.lines, text: "nope" } })).rejects.toMatchObject({ code: "db/mapping-invalid" });
    await expect(MappedDbReader.open(file, { ...m, lines: { ...m.lines, table: "nope" } })).rejects.toMatchObject({ code: "db/mapping-invalid" });
  });
});

describe("text values", () => {
  it("plain, HTML, UTF-8 BLOB, gzip and zlib decode; opaque binary is refused", () => {
    const c = new GenericTextCodec();
    expect(c.decode("<p>שלום</p>")).toBe("<p>שלום</p>");
    expect(c.decode(new TextEncoder().encode("שלום"))).toBe("שלום");
    expect(c.decode(gzipSync(new TextEncoder().encode("שלום עולם")))).toBe("שלום עולם");
    expect(blobKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toBe("binary");
    expect(() => c.decode(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toThrow(expect.objectContaining({ code: "db/value-not-text" }));
  });

  it("a gzip bomb stops at the cap, fast", () => {
    const bomb = gzipSync(new Uint8Array(64 * 1024 ** 2), { level: 9 });
    const t0 = Date.now();
    expect(() => new GenericTextCodec().decode(bomb)).toThrow(expect.objectContaining({ code: "db/compressed-corrupt" }));
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

/* ---------------- large and hostile databases, generated here ---------------- */

const BOOKS = 50;
const LINES = 50_000;
function largeDb(opts: { index?: string; single?: boolean }): Uint8Array {
  const db = new SQL.Database();
  db.run("PRAGMA page_size = 4096");
  if (opts.single) db.run("CREATE TABLE t (title TEXT, n INTEGER, body TEXT)");
  else {
    db.run("CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT)");
    db.run("CREATE TABLE lines (id INTEGER PRIMARY KEY, book INTEGER, n INTEGER, body TEXT)");
    for (let b = 1; b <= BOOKS; b++) db.run("INSERT INTO books VALUES (?, ?)", [b, `ספר ${b}`]);
  }
  if (opts.index) db.run(opts.index);
  const ins = db.prepare(opts.single ? "INSERT INTO t VALUES (?,?,?)" : "INSERT INTO lines (book, n, body) VALUES (?,?,?)");
  db.run("BEGIN");
  // books interleaved and each book's lines inserted in REVERSE order: the order column decides
  for (let i = 0; i < LINES; i++) {
    const b = (i % BOOKS) + 1;
    const n = LINES / BOOKS - 1 - Math.floor(i / BOOKS);
    ins.run([opts.single ? `ספר ${b}` : b, n, `שורה ${n} של ספר ${b} — ${"טקסט ".repeat(12)}`]);
  }
  db.run("COMMIT");
  ins.free();
  const bytes = db.export();
  db.close();
  return bytes;
}

const TWO: DbMapping = { layout: "two-tables", books: { table: "books", id: "id", title: "title" }, lines: { table: "lines", book: "book", order: "n", text: "body" } };
const ONE: DbMapping = { layout: "single-table", lines: { table: "t", book: "title", order: "n", text: "body" } };

describe("50,000 lines: open and read stay fast", () => {
  for (const [name, opts, mapping, strategy] of [
    ["two tables, no index (one scan)", {}, TWO, "scan"],
    ["two tables, index (book, n) (no scan)", { index: "CREATE INDEX ix ON lines(book, n)" }, TWO, "index"],
    ["two tables, index (book) only", { index: "CREATE INDEX ix ON lines(book)" }, TWO, "index"],
    ["one table, no index (one scan)", { single: true }, ONE, "scan"],
  ] as const) {
    it(name, async () => {
      const bytes = largeDb(opts);
      const t0 = performance.now();
      const file = await SqliteFile.open(bytesSource(bytes));
      const r = await MappedDbReader.open(file, mapping);
      const opened = performance.now() - t0;
      expect(r.strategy).toBe(strategy);
      expect(r.books).toHaveLength(BOOKS);
      const t1 = performance.now();
      const chunk = await r.lines(17, 200, 399);
      const firstChunk = performance.now() - t1;
      const t2 = performance.now();
      await r.lines(17, 400, 599);
      const nextChunk = performance.now() - t2;
      expect(chunk).toHaveLength(200);
      expect(chunk[0]!.text).toMatch(/^שורה 200 של ספר 18 /);
      expect(chunk[199]!.text).toMatch(/^שורה 399 של ספר 18 /);
      console.log(`[perf] ${name}: open ${opened.toFixed(0)}ms (${(bytes.length / 1024 ** 2).toFixed(1)}MB), first chunk ${firstChunk.toFixed(0)}ms, next ${nextChunk.toFixed(0)}ms`);
      expect(opened).toBeLessThan(10_000);
      expect(firstChunk + nextChunk).toBeLessThan(5_000);
    }, 30_000);
  }

  it("a scan can be cancelled, and reports progress", async () => {
    const file = await SqliteFile.open(bytesSource(largeDb({})));
    const ac = new AbortController();
    const seen: [number, number][] = [];
    const p = MappedDbReader.open(file, TWO, { signal: ac.signal, progress: (d, t) => (seen.push([d, t]), d > 50 && ac.abort()) });
    await expect(p).rejects.toThrow(/abort/i);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(([d, t]) => d < t)).toBe(true);
  }, 30_000);
});

describe("hostile generic databases fail fast", () => {
  /** A table whose interior root page points every child at the same subtree (a DAG). */
  function sharedChildren(selfLoop: boolean): Uint8Array {
    const db = new SQL.Database();
    db.run("PRAGMA page_size = 512");
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, title TEXT, body TEXT)");
    for (let i = 0; i < 3000; i++) db.run("INSERT INTO t (title, body) VALUES (?, ?)", [`ספר ${i % 3}`, "x".repeat(40)]);
    const root = Number(db.exec("SELECT rootpage FROM sqlite_master WHERE name = 't'")[0]!.values[0]![0]);
    const bytes = db.export();
    db.close();
    const at = (root - 1) * 512;
    expect(bytes[at]).toBe(5); // interior table page
    const cells = (bytes[at + 3]! << 8) | bytes[at + 4]!;
    const childOf = (i: number) => {
      const ptr = (bytes[at + 12 + 2 * i]! << 8) | bytes[at + 13 + 2 * i]!;
      return at + ptr;
    };
    const target = selfLoop ? root : new DataView(bytes.buffer).getUint32(childOf(0));
    for (let i = 0; i < cells; i++) new DataView(bytes.buffer).setUint32(childOf(i), target);
    new DataView(bytes.buffer).setUint32(at + 8, target);
    return bytes;
  }

  it("a b-tree cycle: the preview and the reader both refuse it", async () => {
    const bytes = sharedChildren(true);
    await expect(previewSchema(await SqliteFile.open(bytesSource(bytes)))).rejects.toThrow(/פגום|מעגל/);
    await expect(MappedDbReader.open(await SqliteFile.open(bytesSource(bytes)), { layout: "single-table", lines: { table: "t", book: "title", order: ROWID, text: "body" } })).rejects.toThrow(/פגום|מעגל/);
  }, 10_000);

  it("every child pointing at one page: bounded, never an endless or exploding walk", async () => {
    const bytes = sharedChildren(false);
    const t0 = Date.now();
    try {
      const r = await MappedDbReader.open(await SqliteFile.open(bytesSource(bytes)), { layout: "single-table", lines: { table: "t", book: "title", order: ROWID, text: "body" } });
      expect(r.books.length).toBeLessThanOrEqual(3);
    } catch (err) {
      expect(String(err)).toMatch(/פגום/);
    }
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 10_000);
});
