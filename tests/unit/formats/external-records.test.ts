import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { appendRecords, externalRecords } from "../../../src/formats/links-json/external";
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
