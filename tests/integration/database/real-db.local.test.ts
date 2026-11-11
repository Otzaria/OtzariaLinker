import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ByteSource } from "../../../src/database/sqlite/lazy/byte-source";
import { SqliteFile } from "../../../src/database/sqlite/lazy/sqlite-file";
import { OtzariaDbReader } from "../../../src/database/otzaria/reader";

/*
 * Runs only on a machine with a real Otzaria database:
 *   OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npx vitest run tests/integration/database/real-db.local.test.ts
 * The file is opened read-only ("r") and never written.
 */
const path = process.env.OTZARIA_DB;
const fd = path ? openSync(path, "r") : -1;
const source: ByteSource | null = path
  ? {
      size: fstatSync(fd).size,
      async read(offset, length) {
        const buf = new Uint8Array(length);
        const n = readSync(fd, buf, 0, length, offset);
        return buf.subarray(0, n);
      },
    }
  : null;

afterAll(() => {
  if (path) closeSync(fd);
});

describe.runIf(path)("real seforim.db (read-only)", () => {
  let file: SqliteFile;
  beforeAll(async () => { file = await SqliteFile.open(source!); });

  it("reads the header and schema_meta", async () => {
    expect(file.header.wal).toBe(false);
    const meta = Object.fromEntries((await collect(file.scan((await file.table("schema_meta"))!))).map((r) => [r.values[0], r.values[1]]));
    expect(Number(meta.db_schema_version)).toBeGreaterThanOrEqual(6);
  });

  it("column names match PRAGMA-level truth despite comments in the DDL (TD-H5)", async () => {
    const book = (await file.table("book"))!;
    expect(book.columns.map((c) => c.name)).toContain("notesContent");
    expect(book.columns.map((c) => c.name)).not.toContain("no");
    const range = (await file.table("link_range"))!;
    expect(range.columns.map((c) => c.name)).toContain("endLineIndex");
    expect(range.columns.map((c) => c.name)).not.toContain("for");
  });

  it("a book's line ids and indexes via idx_line_book_index — few pages, fast (TD-H6)", async () => {
    const book = (await file.table("book"))!;
    const titleCol = book.columns.findIndex((c) => c.name === "title");
    let bereshit: number | null = null;
    for await (const r of file.scan(book)) if (r.values[titleCol] === "בראשית") { bereshit = r.rowid; break; }
    expect(bereshit).not.toBeNull();
    const ix = (await file.indexesOf("line")).find((i) => i.name === "idx_line_book_index")!;
    const before = file.pagesRead;
    const t0 = performance.now();
    const entries = await collect(file.seekIndex(ix, [bereshit]));
    const ms = performance.now() - t0;
    const pages = file.pagesRead - before;
    console.log(`בראשית: ${entries.length} lines, ${pages} pages, ${ms.toFixed(0)} ms`);
    expect(entries.length).toBeGreaterThan(1000);
    expect(entries.map((e) => e[1])).toEqual([...entries.map((e) => e[1] as number)].sort((a, b) => a - b));
    expect(pages).toBeLessThan(200);
  });
});

describe.runIf(path)("real seforim.db through OtzariaDbReader (read-only)", () => {
  it("opens, lists every book and reads whole books quickly", async () => {
    const t0 = performance.now();
    const reader = await OtzariaDbReader.open(source!);
    const books = await reader.books();
    const tBooks = performance.now() - t0;
    expect(reader.caps).toMatchObject({ kind: "official", inferredSchema: 7, compressed: true });
    expect(books.length).toBeGreaterThan(8000);
    const timings: string[] = [`open+books ${books.length}: ${tBooks.toFixed(0)} ms`];
    for (const title of ["בראשית", "משנה ברורה", "שער הציון"]) {
      const b = books.find((x) => x.title === title)!;
      const before = reader.file.pagesRead;
      const t1 = performance.now();
      const lines = await reader.lines(b.id);
      const ms = performance.now() - t1;
      expect(lines.length).toBe(b.totalLines);
      expect(lines.every((l, i) => l.index === i)).toBe(true);
      timings.push(`${title}: ${lines.length} lines, ${reader.file.pagesRead - before} pages, ${ms.toFixed(0)} ms`);
    }
    console.log(timings.join(" | "));
  }, 120_000);
});

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
