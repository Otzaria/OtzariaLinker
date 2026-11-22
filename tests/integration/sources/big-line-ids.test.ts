import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";

/*
 * Personal databases made by Personal-DB-Creator number lines `bookId * 2^20 + lineIndex + 1`, so ids go past
 * 2^32 (the real v52 reaches 10,332,667,988: docs/research/PERSONAL_DB_V52_AUDIT.md) and link ids can too.
 * The listing held line and link ids in Int32Array and truncated them: every link of such a database lost
 * its line (-1) and could not be fetched. Real DDL (tests/fixtures/schemas/v0.sql), ids as the real file has them.
 */
const require = createRequire(import.meta.url);
const v0 = readFileSync("tests/fixtures/schemas/v0.sql", "utf8");
const LINE = (book: number, i: number) => book * 2 ** 20 + i + 1;
const BIG_LINK = 2 ** 33 + 12345;

async function database(): Promise<Uint8Array> {
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  const d = new SQL.Database();
  d.exec(v0);
  d.exec(`INSERT INTO source(id, name) VALUES (1, 'x');
          INSERT INTO category(id, title) VALUES (1, 'x');
          INSERT INTO book(id, categoryId, sourceId, title, isBaseBook) VALUES (9853, 1, 1, 'PLACEHOLDER base', 1), (9854, 1, 1, 'PLACEHOLDER commentary', 0);
          INSERT INTO connection_type(id, name) VALUES (1, 'COMMENTARY');`);
  for (const b of [9853, 9854]) for (let i = 0; i < 5; i++) d.run("INSERT INTO line(id, bookId, lineIndex, content) VALUES (?, ?, ?, ?)", [LINE(b, i), b, i, `PLACEHOLDER ${i}`]);
  d.run("INSERT INTO link(id, sourceBookId, targetBookId, sourceLineId, targetLineId, targetLineIndex, connectionTypeId) VALUES (?, 9853, 9854, ?, ?, 3, 1)", [BIG_LINK, LINE(9853, 2), LINE(9854, 3)]);
  d.run("INSERT INTO link(id, sourceBookId, targetBookId, sourceLineId, targetLineId, targetLineIndex, connectionTypeId) VALUES (?, 9853, 9854, ?, ?, 1, 1)", [BIG_LINK + 1, LINE(9853, 0), LINE(9854, 1)]);
  const bytes = d.export();
  d.close();
  return bytes;
}

describe("line and link ids above 2^32", () => {
  it("a book's links keep their own line and can be fetched, in line order", async () => {
    expect(LINE(9854, 0)).toBeGreaterThan(2 ** 32);
    const r = new SourceRegistry();
    const res = await r.open([{ path: "big.db", blob: new Blob([(await database()) as BlobPart]) }]);
    const id = res.sources[0]!.info.id;
    const page = await r.dbLinksPage(`${id}:9853`, { offset: 0, limit: 10 });
    expect(page.total).toBe(2);
    // in the order of the book's own lines (line 0 before line 2) — a truncated line id sorted them as -1
    expect(page.links.map((l) => [l.source.line, l.target.line])).toEqual([[0, 1], [2, 3]]);
    expect(page.links.map((l) => l.id)).toEqual([`${id}:link:${BIG_LINK + 1}`, `${id}:link:${BIG_LINK}`]);
    // the other end, with the same ids
    const back = await r.dbLinksPage(`${id}:9854`, { offset: 0, limit: 10, lines: { from: 3, to: 3 } });
    expect(back.links.map((l) => [l.source.line, l.target.line])).toEqual([[2, 3]]);
  });
});
