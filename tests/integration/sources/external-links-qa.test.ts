import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import type { DbLinkSummary } from "../../../src/core/links/db-links";
import { SourceRegistry } from "../../../src/sources/registry";

/*
 * QA of the external_link reader (#13): rows the base fixture does not hold, added to a copy of it in memory
 * with sql.js (the DDL stays the real v52 one; rows are placeholders). See external-links.test.ts for the rules.
 */
const require = createRequire(import.meta.url);
const FIXTURE = new Uint8Array(readFileSync("tests/fixtures/db/pdc-personal-mini.db"));
const OFFICIAL = () => ({ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) });
const ROW = "INSERT INTO external_link (sourceBookId, sourceLineIndex, targetSource, targetTitle, targetRef, targetLineIndex, connectionType) VALUES (?, ?, ?, ?, ?, ?, ?)";

async function variant(sql: (run: (q: string, args?: unknown[]) => void) => void): Promise<{ path: string; blob: Blob }> {
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  const d = new SQL.Database(FIXTURE);
  sql((q, args = []) => void d.run(q, args as never));
  const bytes = d.export();
  d.close();
  return { path: "personal.db", blob: new Blob([bytes as BlobPart]) };
}
async function openWith(file: { path: string; blob: Blob }, withOfficial: boolean) {
  const r = new SourceRegistry();
  const res = await r.open(withOfficial ? [OFFICIAL(), file] : [file]);
  const pdc = res.sources.find((s) => s.info.label === "personal.db")!;
  return { r, pdc, official: res.sources.find((s) => s.info.label === "seforim.db"), key: (id: number) => `${pdc.info.id}:${id}` };
}
const summary = async (r: SourceRegistry, key: string): Promise<DbLinkSummary> => {
  const s = await r.dbLinkSummary(key);
  if (!("total" in s)) throw new Error(s.reason);
  return s;
};

describe("targetSource NULL means any source, the library first — also for the links INTO a book", () => {
  // book 20 is titled like a library book; two rows name that title with no targetSource
  const file = () =>
    variant((run) => {
      run("INSERT INTO book (id, categoryId, sourceId, title, orderIndex, totalLines, isBaseBook, hasSourceConnection) VALUES (20, 1, 1, 'בראשית', 1, 2, 0, 0)");
      for (let i = 0; i < 2; i++) run("INSERT INTO line (id, bookId, lineIndex, heRef, tocEntryId) VALUES (?, 20, ?, NULL, NULL)", [20 * 2 ** 20 + i + 1, i]);
      run(ROW, [11, 3, null, "בראשית", null, 1, "REFERENCE"]);
      run(ROW, [11, 2, null, "PLACEHOLDER notes on base", null, 1, "FOOTNOTES"]);
    });

  it("without a library that has the title, the row reaches this database's book (it is not silently dropped)", async () => {
    const { r, key } = await openWith(await file(), false);
    const s = await summary(r, key(20));
    expect(s).toMatchObject({ total: 1, out: 0, in: 1 });
    const page = await r.dbLinksPage(key(20), { offset: 0, limit: 5 });
    expect(page.links[0]).toMatchObject({ source: { line: 3, book: { title: "PLACEHOLDER base" } }, target: { line: 1, book: { title: "בראשית" } } });
    // a NULL row to a title that is not the library's is internal as well
    expect((await summary(r, key(12))).in).toBe(3); // 2 FOOTNOTES of the fixture + the NULL row
  });

  it("with the library open, the same row goes to the library's book, not to this one", async () => {
    const { r, official, key } = await openWith(await file(), true);
    expect((await summary(r, key(20))).total).toBe(0);
    const bereshit = official!.books.find((b) => b.title === "בראשית")!;
    const out = await r.dbLinksPage(key(11), { offset: 0, limit: 20, dir: "out" });
    expect(out.links.find((l) => l.target.book.title === "בראשית")!.target.book.key).toBe(bereshit.key);
  });
});

describe("a book title that two of the database's books share: the first (lowest id) wins", () => {
  it("one rule for the database and the registry", async () => {
    const f = await variant((run) => {
      run("INSERT INTO book (id, categoryId, sourceId, title, orderIndex, totalLines, isBaseBook, hasSourceConnection) VALUES (30, 1, 1, 'PLACEHOLDER base', 1, 1, 0, 0)");
      run("INSERT INTO line (id, bookId, lineIndex, heRef, tocEntryId) VALUES (?, 30, 0, NULL, NULL)", [30 * 2 ** 20 + 1]);
      run(ROW, [12, 1, "pdc-fixture", "PLACEHOLDER base", null, 0, "REFERENCE"]);
    });
    const { r, key } = await openWith(f, false);
    const page = await r.dbLinksPage(key(12), { offset: 0, limit: 20, dir: "out" });
    expect(page.links.find((l) => l.source.line === 1)!.target.book.key).toBe(key(11));
  });
});

describe("the total is what the pages show (a row that is dropped is not counted)", () => {
  it("a row with only a ref counts when its ref resolves, and not when it does not", async () => {
    const f = await variant((run) => {
      run(ROW, [9854, 2, "official", "בראשית", "בראשית, א, ב", null, "SOURCE"]); // resolves by ref when the library is open
      run(ROW, [9854, 3, "official", "PLACEHOLDER unknown", "PLACEHOLDER ref", null, "SOURCE"]); // never resolves
    });
    const closed = await openWith(f, false);
    expect((await summary(closed.r, closed.key(9854))).total).toBe(7);
    const withLib = await openWith(f, true);
    const s = await summary(withLib.r, withLib.key(9854));
    expect(s.total).toBe(8);
    const page = await withLib.r.dbLinksPage(withLib.key(9854), { offset: 0, limit: 50 });
    expect(page.links).toHaveLength(s.total);
    expect(page.total).toBe(s.total);
  });
});
