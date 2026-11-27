import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { linePairIdentity } from "../../../src/core/links/equality";
import { appendRecords, externalRecords, officialRefKey, recordedLinks } from "../../../src/formats/links-json/external";
import { parseLinksJson } from "../../../src/formats/links-json/parse";

/*
 * zmanenu-library's records for a link to the official library (docs/format.md "target_library", read 2026-11-26): the record is
 * in the repository book's own file, the type is not reversed, heRef_2 is preferred, ranges and anchors are not supported.
 */
const mine: BookRef = { key: "r:1", title: "ביאור לדוגמה על בראשית", origin: "otzaria" };
const official: BookRef = { key: "db:1", title: "בראשית", origin: "otzaria" };
const ctx = {
  isRepo: (b: BookRef) => b.key.startsWith("r:"),
  isOfficial: (b: BookRef) => b.key.startsWith("db:"),
  heRefOf: (s: { line: number }) => (s.line === 2 ? "בראשית, א, א" : null),
};
const link = (over: Partial<Link>): Link => ({ id: "x", status: "new", provenance: "auto", source: { book: mine, line: 3 }, target: { book: official, line: 2 }, declaredType: "source", heRef2: "בראשית, א, א", ...over });

describe("externalRecords", () => {
  it("a commentary of the repository on an official book: one record, 1-based, type source, heRef_2 of the official line", () => {
    const r = externalRecords([link({})], ctx);
    expect(r.byTitle.get(mine.title)).toEqual([{ line_index_1: 4, target_library: "official", book_2: "בראשית", heRef_2: "בראשית, א, א", "Conection Type": "source" }]);
    expect(r.skipped).toEqual([]);
  });

  it("the same link written the other way (commentary from the base): the same record", () => {
    const r = externalRecords([link({ source: { book: official, line: 2 }, target: { book: mine, line: 3 }, declaredType: "commentary" })], ctx);
    expect(r.byTitle.get(mine.title)).toEqual([{ line_index_1: 4, target_library: "official", book_2: "בראשית", heRef_2: "בראשית, א, א", "Conection Type": "source" }]);
  });

  it("no heRef on the official line: line_index_2 instead", () => {
    const r = externalRecords([link({ target: { book: official, line: 7 } })], ctx);
    expect(r.byTitle.get(mine.title)![0]).toMatchObject({ line_index_2: 8 });
    expect(r.byTitle.get(mine.title)![0]).not.toHaveProperty("heRef_2");
  });

  it("refused with a reason: the repository book as the base, a targum, a reference out of the official book, two repository books", () => {
    const r = externalRecords(
      [
        link({ id: "a", source: { book: official, line: 2 }, target: { book: mine, line: 3 }, declaredType: "source" }),
        link({ id: "b", declaredType: "targum" }),
        link({ id: "c", source: { book: official, line: 2 }, target: { book: mine, line: 3 }, declaredType: "reference" }),
        link({ id: "d", target: { book: { ...mine, key: "r:2", title: "אחר" }, line: 1 } }),
      ],
      ctx,
    );
    expect(r.byTitle.size).toBe(0);
    expect(r.skipped.map((s) => [s.link.id, s.code])).toEqual([["a", "external/direction"], ["b", "external/type"], ["c", "external/direction"], ["d", "external/ends"]]);
    expect(r.skipped.every((s) => /[א-ת]/.test(s.text))).toBe(true);
  });

  it("a range and an anchor are left out, and said", () => {
    const r = externalRecords([link({ source: { book: mine, line: 3, end: 5 }, anchor: { rawStart: 0, rawEnd: 4 } })], ctx);
    expect(r.byTitle.get(mine.title)![0]).not.toHaveProperty("line_index_1_end");
    expect(r.warnings[0]!.text).toMatch(/טווח ו?עוגן/);
  });
});

describe("appendRecords", () => {
  const rec = { line_index_1: 4, target_library: "official", book_2: "בראשית", heRef_2: "בראשית, א, א", "Conection Type": "source" };
  it("a new file: the default layout", () => {
    const { text, added } = appendRecords(null, [rec, rec]);
    expect(added).toBe(1);
    expect(JSON.parse(text)).toEqual([rec]);
  });

  it("an existing file keeps its bytes; the new records follow in its layout; one it has is not added again", () => {
    const old = '[\n    {\n        "line_index_1": 3,\n        "line_index_2": 3,\n        "path_2": "ספר.txt",\n        "Conection Type": "source"\n    }\n]\n';
    const { text, added } = appendRecords(old, [rec]);
    expect(added).toBe(1);
    expect(text.startsWith(old.slice(0, old.lastIndexOf("}") + 1))).toBe(true);
    expect(text.endsWith("]\n")).toBe(true);
    expect(text).toContain('\n    {\n        "line_index_1": 4,');
    expect(JSON.parse(text)).toHaveLength(2);
    expect(appendRecords(text, [rec])).toEqual({ text, added: 0 });
    // the official generator cannot read a target_library record, and refuses such a file whole: that is why the runner never loads
    // and rewrites a zmanenu file through the official format (it would drop these records), and appends to it instead
    expect(parseLinksJson(text).generatorRejectsFile).toBe(true);
  });

  it("an empty array and a compact file", () => {
    expect(JSON.parse(appendRecords("[]", [rec]).text)).toEqual([rec]);
    const compact = appendRecords('[{"line_index_1":1}]', [rec]).text;
    expect(compact).toBe(`[{"line_index_1":1},${JSON.stringify(rec)}]`);
  });
});

// V7 round 2, item 8: a repository checked out with CRLF (git core.autocrlf on Windows) — the records added keep its line endings,
// so the file is not left with both
describe("appendRecords on a CRLF file", () => {
  it("the added elements use CRLF too; the existing text is kept byte for byte", () => {
    const old = '[\r\n  {\r\n    "line_index_1": 1\r\n  }\r\n]\r\n';
    const rec = { line_index_1: 2, target_library: "official", book_2: "בראשית", heRef_2: "בראשית, א, א", "Conection Type": "source" };
    const out = appendRecords(old, [rec]).text;
    expect(out.startsWith('[\r\n  {\r\n    "line_index_1": 1\r\n  }')).toBe(true);
    expect(/(^|[^\r])\n/.test(out)).toBe(false);
    expect(JSON.parse(out)).toEqual([{ line_index_1: 1 }, rec]);
  });
});

// V7 round 2, item 9: the links a kept-aside zmanenu file already says, as "the same lines" (core/links/equality.ts)
describe("recordedLinks", () => {
  const side = (title: string, line: number) => ({ book: { key: "", title, origin: "unknown" as const }, line });
  const pair = (a: string, la: number, b: string, lb: number) => linePairIdentity({ source: side(a, la), target: side(b, lb) });

  it("book_2 and path_2 records inside the repository, official records by line and by heRef; another library's and broken records are not links", () => {
    const text = JSON.stringify([
      { line_index_1: 3, line_index_2: 5, book_2: "ספר", "Conection Type": "source" },
      { line_index_1: 4, line_index_2: 6, path_2: "תיקייה/ספר אחר.txt", "Conection Type": "reference" },
      { line_index_1: 7, target_library: "רשמי", book_2: "בראשית", line_index_2: 4, "Conection Type": "source" },
      { line_index_1: 8, target_library: "official", book_2: "בראשית", heRef_2: " בראשית, א, ג ", "Conection Type": "source" },
      { line_index_1: 9, target_library: "otzaria.other", book_2: "בראשית", line_index_2: 9, "Conection Type": "source" },
      { line_index_1: 0, line_index_2: 2, book_2: "ספר", "Conection Type": "source" },
      { line_index_1: 2, book_2: "ספר", "Conection Type": "source" },
      "not a record",
    ]);
    const got = recordedLinks("ביאור", text);
    expect([...got.pairs].sort()).toEqual([pair("ביאור", 2, "ספר", 4), pair("ביאור", 3, "ספר אחר", 5), pair("ביאור", 6, "בראשית", 3)].sort());
    // either direction: the identity is unordered
    expect(got.pairs.has(pair("ספר", 4, "ביאור", 2))).toBe(true);
    expect([...got.officialRefs]).toEqual([officialRefKey("ביאור", 7, "בראשית", "בראשית, א, ג")]);
  });

  // V7 round 2 review, finding 11: a book's title is what the title rules make of its file name (core/links/titles.ts
  // otzariaBookTitle, as the runner names the repository's books), and a record names the book as its FILE does ("ספר  לדוגמה", two
  // spaces). Compared as written, the pair was not known and the run wrote it again.
  it("a book_2 or path_2 inside the repository is read with the title rules: a file name with two spaces is the same book", () => {
    const text = JSON.stringify([
      { line_index_1: 3, line_index_2: 5, book_2: "ספר  לדוגמה", "Conection Type": "source" },
      { line_index_1: 4, line_index_2: 6, path_2: "תיקייה/ספר  אחר.txt", "Conection Type": "reference" },
      { line_index_1: 5, line_index_2: 7, book_2: ' ספר "שלישי" ', "Conection Type": "reference" },
    ]);
    const got = recordedLinks("ביאור", text);
    expect(got.pairs.has(pair("ביאור", 2, "ספר לדוגמה", 4))).toBe(true);
    expect(got.pairs.has(pair("ביאור", 3, "ספר אחר", 5))).toBe(true);
    expect(got.pairs.has(pair("ביאור", 4, "ספר ״שלישי״", 6))).toBe(true);
    // the name as written is kept too (a book whose title is that exact name)
    expect(got.pairs.has(pair("ביאור", 2, "ספר  לדוגמה", 4))).toBe(true);
  });

  it("a target_library record keeps the official title as it is (the official library matches titles exactly)", () => {
    const text = JSON.stringify([{ line_index_1: 7, target_library: "official", book_2: "בראשית  רבה", line_index_2: 4, heRef_2: "x", "Conection Type": "source" }]);
    const got = recordedLinks("ביאור", text);
    expect([...got.pairs]).toEqual([pair("ביאור", 6, "בראשית  רבה", 3)]);
    expect([...got.officialRefs]).toEqual([officialRefKey("ביאור", 6, "בראשית  רבה", "x")]);
  });

  it("a file that is not a JSON array adds nothing", () => {
    expect(recordedLinks("x", "{").pairs.size).toBe(0);
    expect(recordedLinks("x", "{}").pairs.size).toBe(0);
  });
});
