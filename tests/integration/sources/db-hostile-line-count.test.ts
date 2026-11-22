import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { MAX_BOOK_LINES } from "../../../src/core/limits";
import { SourceRegistry } from "../../../src/sources/registry";

/*
 * QA round 2, C: `book.totalLines` is a number a database claims about itself. A hostile one (1e9) used to
 * reach callers as the book's lineCount, and they allocate arrays of that size. It is now not a line count at
 * all: the book has none (the lines themselves are counted when read) and the source carries a warning.
 */
const require = createRequire(import.meta.url);
const FIXTURE = new Uint8Array(readFileSync("tests/fixtures/db/pdc-personal-mini.db"));

async function open(totals: Record<number, number | string>) {
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  const d = new SQL.Database(FIXTURE);
  for (const [id, v] of Object.entries(totals)) d.run("UPDATE book SET totalLines = ? WHERE id = ?", [v, Number(id)]);
  const bytes = d.export();
  d.close();
  const res = await new SourceRegistry().open([{ path: "personal.db", blob: new Blob([bytes as BlobPart]) }]);
  return res.sources[0]!;
}

describe("a line count a database claims is validated", () => {
  it("a count beyond any book, a negative one and a fraction are not line counts; the source warns in Hebrew", async () => {
    const src = await open({ 11: 1_000_000_000, 12: -5, 9854: 2.5 });
    const books = src.books;
    for (const b of books) expect(b.lineCount, b.title).toBeUndefined();
    const w = src.info.warnings.find((x) => x.code === "db/book-line-count-invalid");
    expect(w?.message).toMatch(/שורות/);
    expect(w?.message).toContain("PLACEHOLDER base");
  });
  it("the limit itself and ordinary counts are kept, without a warning", async () => {
    const src = await open({ 11: MAX_BOOK_LINES });
    const books = src.books;
    expect(books.find((b) => b.title === "PLACEHOLDER base")!.lineCount).toBe(MAX_BOOK_LINES);
    expect(books.find((b) => b.title === "PLACEHOLDER commentary on official")!.lineCount).toBe(6);
    expect(src.info.warnings.map((x) => x.code)).not.toContain("db/book-line-count-invalid");
  });
});
