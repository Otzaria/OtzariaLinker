import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DbLinkSummary } from "../../../src/core/links/db-links";
import { SourceRegistry } from "../../../src/sources/registry";

/*
 * #13: a personal database made by Personal-DB-Creator keeps ALL its links in `external_link` and has no
 * `link` table, so the tool listed none ("אין טבלת קישורים"). The fixture has the real v52 DDL and placeholder
 * rows (scripts/fixtures/make_pdc_mini_db.py; the official counterpart is seforim-v7-mini.db).
 *
 * What external_link means (docs/research/PERSONAL_DB_V52_AUDIT.md §4): sourceBookId/sourceLineIndex = a book of
 * THIS database and its 0-based line; targetSource 'official' = the library, = the database's own library_id =
 * itself; targetTitle exact; targetRef = the heRef of the target line (preferred), targetLineIndex the fallback;
 * connectionType free text, NULL = REFERENCE. No anchors, ranges, hidden sides or ids (the id is the rowid).
 */
const PDC = () => ({ path: "personal.db", blob: new Blob([readFileSync("tests/fixtures/db/pdc-personal-mini.db")]) });
const OFFICIAL = () => ({ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) });

async function open(withOfficial: boolean) {
  const r = new SourceRegistry();
  const res = await r.open(withOfficial ? [OFFICIAL(), PDC()] : [PDC()]);
  const pdc = res.sources.find((s) => s.info.label === "personal.db")!;
  const official = res.sources.find((s) => s.info.label === "seforim.db");
  const key = (id: number) => `${pdc.info.id}:${id}`;
  return { r, pdc, official, key };
}
const summary = async (r: SourceRegistry, key: string): Promise<DbLinkSummary> => {
  const s = await r.dbLinkSummary(key);
  if (!("total" in s)) throw new Error(`no summary: ${s.reason}`);
  return s;
};

describe("external_link is read when there is no link table", () => {
  it("the database is recognised and its books list their links instead of 'no link table'", async () => {
    const { r, pdc, key } = await open(false);
    expect(pdc.info.warnings.map((w) => w.code)).not.toContain("db/links-unindexed");
    const s = await summary(r, key(9854));
    expect(s).toMatchObject({ total: 7, out: 6, in: 1, method: "index" });
    expect(Object.fromEntries(s.byType.map((t) => [t.type, [t.out, t.in]]))).toEqual({ SOURCE: [6, 0], COMMENTARY: [0, 1] });
  });

  it("counts by direction and type of the other books (internal links are found from both ends)", async () => {
    const { r, key } = await open(false);
    const base = await summary(r, key(11));
    expect(base).toMatchObject({ total: 5, out: 3, in: 2 });
    expect(Object.fromEntries(base.byType.map((t) => [t.type, [t.out, t.in]]))).toEqual({ FOOTNOTES: [2, 0], COMMENTARY: [1, 0], REFERENCE: [0, 1], SOURCE: [0, 1] });
    const notes = await summary(r, key(12));
    expect(notes).toMatchObject({ total: 3, out: 1, in: 2 });
    expect(notes.byBook.find((b) => b.bookKey === key(11))).toMatchObject({ out: 1, in: 2 }); // base <-> notes
  });

  it("a NULL connectionType is REFERENCE; the stored name SOURCE is kept", async () => {
    const { r, key } = await open(false);
    const page = await r.dbLinksPage(key(12), { offset: 0, limit: 10, dir: "out" });
    expect(page.links.map((l) => l.declaredType)).toEqual(["reference"]);
    const out = await r.dbLinksPage(key(9854), { offset: 0, limit: 10, dir: "out" });
    expect(new Set(out.links.map((l) => l.declaredType))).toEqual(new Set(["source"]));
  });

  it("without the official database open, targets are named by title (not dropped) and say where they point", async () => {
    const { r, key } = await open(false);
    const page = await r.dbLinksPage(key(9854), { offset: 0, limit: 10, dir: "out" });
    expect(page.total).toBe(6);
    const first = page.links[0]!;
    expect(first).toMatchObject({ provenance: "db", status: "existing", source: { line: 0 }, target: { line: 3, book: { key: "unresolved:בראשית", title: "בראשית", origin: "unknown" } }, heRef2: "בראשית, א, ב" });
    expect(first.id).toMatch(/^s\d+:ext:\d+$/);
    expect(first.dbAnchors).toBeUndefined();
    expect(first.dbSuppressed).toBeUndefined();
    expect(page.links[3]!.target.book.key).toBe("unresolved:PLACEHOLDER not in the library");
  });

  it("with the official database open the target is its book, and the heRef decides the line (a wrong index is ignored)", async () => {
    const { r, official, key } = await open(true);
    const bereshit = official!.books.find((b) => b.title === "בראשית")!;
    const s = await summary(r, key(9854));
    expect(s.byBook.find((b) => b.bookKey === bereshit.key)).toMatchObject({ title: "בראשית", origin: "sefaria", out: 4 });
    const page = await r.dbLinksPage(key(9854), { offset: 0, limit: 10, dir: "out" });
    expect(page.links.slice(0, 3).map((l) => [l.target.book.key, l.target.line])).toEqual([
      [bereshit.key, 3], // "בראשית, א, ב" is line 3 of the library's book
      [bereshit.key, 4],
      [bereshit.key, 5], // targetLineIndex says 9999; the ref says line 5
    ]);
    // no ref: the index stays, even beyond the book (the reader shows it, the checks flag it)
    expect(page.links[4]!.target).toMatchObject({ line: 100000, book: { key: bereshit.key } });
  });

  it("a book's links in a line range come back as existing links (the reader's panel and the 'already exists' check)", async () => {
    const { r, key } = await open(false);
    const links = await r.existingLinks(key(9854), 0, 1);
    expect(links.map((l) => l.source.line).sort()).toEqual([0, 1]);
    expect(links.every((l) => l.provenance === "db")).toBe(true);
  });

  it("filters by the other book and pages in the book's line order", async () => {
    const { r, key } = await open(false);
    const all = await r.dbLinksPage(key(9854), { offset: 0, limit: 3 });
    expect(all.total).toBe(7);
    expect(all.links.map((l) => l.source.line === 0 || l.target.line)).toBeTruthy();
    const onlyInternal = await r.dbLinksPage(key(9854), { offset: 0, limit: 10, otherBookKey: key(11) });
    expect(onlyInternal.total).toBe(2);
  });
});
