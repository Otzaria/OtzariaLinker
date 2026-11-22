import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import type { DbLinkFlag, DbLinkSummary } from "../../../src/core/links/db-links";
import { SourceRegistry } from "../../../src/sources/registry";

/*
 * Per-link flags of a personal database's external_link rows (#13, "limitations" of PR1): what a reader should know
 * about an existing link before trusting it — a typed `dbFlags` on each listed link and counted in the summary.
 * Not an export rule (a "db" link is never exported). The rows are placeholders on the real v52 DDL
 * (tests/fixtures/db/pdc-personal-mini.db); the real-data case (6,522 links to a title two books share, 162 of them
 * past the end of the personal book) is in external-links-real-db.local.test.ts.
 */
const require = createRequire(import.meta.url);
const FIXTURE = new Uint8Array(readFileSync("tests/fixtures/db/pdc-personal-mini.db"));
const OFFICIAL = () => ({ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) });
const ROW = "INSERT INTO external_link (sourceBookId, sourceLineIndex, targetSource, targetTitle, targetRef, targetLineIndex, connectionType) VALUES (?, ?, ?, ?, ?, ?, ?)";
const lid = (book: number, i: number) => book * 2 ** 20 + i + 1; // the real database's line id rule

async function variant(sql?: (run: (q: string, args?: unknown[]) => void) => void) {
  const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
  const d = new SQL.Database(FIXTURE);
  sql?.((q, args = []) => void d.run(q, args as never));
  const bytes = d.export();
  d.close();
  return { path: "personal.db", blob: new Blob([bytes as BlobPart]) };
}
async function open(file: { path: string; blob: Blob }, withOfficial: boolean) {
  const r = new SourceRegistry();
  const res = await r.open(withOfficial ? [OFFICIAL(), file] : [file]);
  const pdc = res.sources.find((s) => s.info.label === "personal.db")!;
  return { r, key: (id: number) => `${pdc.info.id}:${id}` };
}
const summary = async (r: SourceRegistry, key: string): Promise<DbLinkSummary> => {
  const s = await r.dbLinkSummary(key);
  if (!("total" in s)) throw new Error(s.reason);
  return s;
};
const counts = (s: DbLinkSummary) => Object.fromEntries((s.flags ?? []).map((f) => [f.flag, f.count]));
const flagsOf = async (r: SourceRegistry, key: string) => {
  const p = await r.dbLinksPage(key, { offset: 0, limit: 200 });
  return p.links.map((l) => [`${l.source.book.title}:${l.source.line}>${l.target.book.title}:${l.target.line}`, [...(l.dbFlags ?? [])].sort()] as const);
};

describe("flags on external_link rows", () => {
  it("a target line past the end of the library's book is flagged when that book is open; a reverse pair is flagged on both rows, in both books", async () => {
    const { r, key } = await open(await variant(), true);
    const s = await summary(r, key(9854));
    expect(counts(s)).toEqual({ "target-out-of-range": 1, "reverse-duplicate": 2 });
    const rows = new Map(await flagsOf(r, key(9854)));
    expect(rows.get("PLACEHOLDER commentary on official:4>בראשית:100000")).toEqual(["target-out-of-range"]);
    expect(rows.get("PLACEHOLDER commentary on official:5>PLACEHOLDER base:3")).toEqual(["reverse-duplicate"]);
    expect(rows.get("PLACEHOLDER base:3>PLACEHOLDER commentary on official:5")).toEqual(["reverse-duplicate"]); // the incoming one
    expect(rows.get("PLACEHOLDER commentary on official:0>בראשית:3")).toEqual([]);
    expect(counts(await summary(r, key(11)))).toMatchObject({ "reverse-duplicate": 2 }); // the same pair seen from the other book
  });

  it("without the library open the official target's length is unknown: no out-of-range flag, nothing guessed", async () => {
    const { r, key } = await open(await variant(), false);
    expect(counts(await summary(r, key(9854)))).toEqual({ "reverse-duplicate": 2 });
  });

  it("an internal target past the end of its own book is flagged", async () => {
    const f = await variant((run) => run(ROW, [11, 2, "pdc-fixture", "PLACEHOLDER notes on base", null, 9, "FOOTNOTES"]));
    const { r, key } = await open(f, false);
    const rows = new Map(await flagsOf(r, key(11)));
    expect(rows.get("PLACEHOLDER base:2>PLACEHOLDER notes on base:9")).toEqual(["target-out-of-range"]);
    expect(counts(await summary(r, key(12)))["target-out-of-range"]).toBe(1);
  });

  it("a header line on either end (a line with a table-of-contents entry) is flagged", async () => {
    const f = await variant((run) => {
      run("INSERT INTO tocText (id, text) VALUES (1, 'PLACEHOLDER heading')");
      // book 12 line 0 is a heading (the target of 11:0), book 11 line 1 is a heading (the source of 11:1)
      run("INSERT INTO tocEntry (id, bookId, parentId, textId, level, lineId) VALUES (1, 12, NULL, 1, 1, ?)", [lid(12, 0)]);
      run("INSERT INTO tocEntry (id, bookId, parentId, textId, level, lineId) VALUES (2, 11, NULL, 1, 1, ?)", [lid(11, 1)]);
    });
    const { r, key } = await open(f, false);
    const rows = new Map(await flagsOf(r, key(11)));
    expect(rows.get("PLACEHOLDER base:0>PLACEHOLDER notes on base:0")).toEqual(["header-target"]);
    expect(rows.get("PLACEHOLDER base:1>PLACEHOLDER notes on base:1")).toEqual(["header-source"]);
    const c = counts(await summary(r, key(11)));
    expect(c["header-target"]).toBe(1);
    expect(c["header-source"]).toBe(2); // 11:1 (outgoing) and 12:0 (the source of the incoming 12:0 → 11:2) are headings
    expect(rows.get("PLACEHOLDER notes on base:0>PLACEHOLDER base:2")).toEqual(["header-source"]);
  });

  it("an internal row whose title the open library also has is flagged ambiguous (which book was meant?), and only then", async () => {
    const f = await variant((run) => {
      run("INSERT INTO book (id, categoryId, sourceId, title, orderIndex, totalLines, isBaseBook, hasSourceConnection) VALUES (20, 1, 1, 'בראשית', 1, 5, 0, 0)");
      for (let i = 0; i < 5; i++) run("INSERT INTO line (id, bookId, lineIndex, heRef, tocEntryId) VALUES (?, 20, ?, NULL, NULL)", [lid(20, i), i]);
      run(ROW, [11, 2, "pdc-fixture", "בראשית", null, 1, "SOURCE"]);
    });
    const withLib = await open(f, true);
    expect(counts(await summary(withLib.r, withLib.key(20)))["ambiguous-title"]).toBe(1);
    const rows = new Map(await flagsOf(withLib.r, withLib.key(11)));
    expect(rows.get("PLACEHOLDER base:2>בראשית:1")).toEqual(["ambiguous-title"]);
    const alone = await open(f, false);
    expect(counts(await summary(alone.r, alone.key(20)))["ambiguous-title"] ?? 0).toBe(0);
  });

  it("every flag is one of the typed names", async () => {
    const { r, key } = await open(await variant(), true);
    const allowed: readonly DbLinkFlag[] = ["target-out-of-range", "header-target", "header-source", "reverse-duplicate", "ambiguous-title"];
    for (const [, flags] of await flagsOf(r, key(9854))) for (const f of flags) expect(allowed).toContain(f);
  });
});
