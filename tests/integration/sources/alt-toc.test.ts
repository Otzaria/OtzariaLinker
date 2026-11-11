import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";

/*
 * alt_toc read from a real database: tests/fixtures/db/seforim-v7-mini.db is a slice of a real
 * seforim.db (scripts/fixtures/make_mini_db.py) that keeps the alt_toc rows of its books. Only part
 * of tocText was kept, so some entries come back without a title — real rows, partial texts.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };

async function open() {
  const reg = new SourceRegistry();
  const res = await reg.open([DB, { path: "ספר.txt", blob: new Blob([strToU8("<h1>ספר</h1>\n<h2>פרק א</h2>\nטקסט\n<h2>פרק ב</h2>\nטקסט")]) }]);
  const book = (title: string) => res.sources.flatMap((s) => s.books).find((b) => b.title === title)!;
  return { reg, book };
}

describe("alt_toc from an open database", () => {
  it("בראשית: the Parasha structure, root and aliyot with their 1-based lines, siblings in row order", async () => {
    const { reg, book } = await open();
    const s = (await reg.altToc(book("בראשית").key))!;
    expect(s.map((x) => [x.key, x.title, x.heTitle])).toEqual([["Parasha", "Genesis", "פרשות"]]);
    const entries = s[0]!.entries;
    expect(entries[0]).toEqual({ heTitle: "בראשית", line: 3, level: 0 });
    expect(entries.slice(1).map((e) => [e.line, e.level])).toEqual([[3, 1], [38, 1], [54, 1], [82, 1], [104, 1], [108, 1]]);
    expect(s[0]!.skipped).toBe(0);
  });

  it("משנה ברורה: automatic-key structures come back too (the state layer sets them apart)", async () => {
    const { reg, book } = await open();
    const s = (await reg.altToc(book("משנה ברורה").key))!;
    expect(s.map((x) => x.key)).toEqual(["Seifim", "SimanNames"]);
    // the fixture kept two Seifim entries whose parents were cut out: they become roots
    expect(s[0]!.entries.map((e) => [e.line, e.level])).toEqual([[9464, 0], [13910, 0]]);
  });

  it("a book without structures gives []; a text source cannot have any (null)", async () => {
    const { reg, book } = await open();
    expect(await reg.altToc(book("שער הציון").key)).toEqual([]);
    expect(await reg.altToc(book("ספר").key)).toBeNull();
  });

  it("headings of a book, in order, without tags", async () => {
    const { reg, book } = await open();
    expect(await reg.headings(book("ספר").key)).toEqual([
      { line: 0, level: 1, text: "ספר" },
      { line: 1, level: 2, text: "פרק א" },
      { line: 3, level: 2, text: "פרק ב" },
    ]);
    const db = await reg.headings(book("בראשית").key);
    expect(db[0]).toMatchObject({ line: 0, level: 1 });
    expect(db.every((h, i) => i === 0 || h.line > db[i - 1]!.line)).toBe(true);
  });

  it("an alt_toc file is handed back as a document, also from inside a ZIP", async () => {
    const reg = new SourceRegistry();
    const res = await reg.open([{ path: "בראשית_alt_toc.json", blob: new Blob(['[{"key":"Parasha","nodes":[]}]']) }]);
    expect(res.documents).toEqual([{ path: "בראשית_alt_toc.json", kind: "alt-toc-json", text: '[{"key":"Parasha","nodes":[]}]' }]);
    const zip = zipSync({ "alt_toc/נח_alt_toc.json": strToU8("[]"), "links/נח_links.json": strToU8("[]") });
    const z = await reg.open([{ path: "export.zip", blob: new Blob([zip]) }]);
    expect(z.documents.map((d) => [d.path, d.kind])).toEqual([["export.zip/alt_toc/נח_alt_toc.json", "alt-toc-json"]]);
  });
});
