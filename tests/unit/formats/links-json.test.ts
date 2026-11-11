import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { storedForm, storedKey } from "../../../src/core/links/stored-form";
import { linkToRecord, recordToLink } from "../../../src/formats/links-json/convert";
import { findDuplicateKey, parseLinksJson } from "../../../src/formats/links-json/parse";
import { serializeLinksJson } from "../../../src/formats/links-json/serialize";

const codes = (text: string) => parseLinksJson(text).issues.map((i) => i.code);
const REC = { line_index_1: 1, heRef_2: "רש״י", path_2: "רש״י על בראשית.txt", line_index_2: 2, "Conection Type": "commentary" };

describe("parseLinksJson — file level", () => {
  it("accepts a clean file", () => expect(codes(JSON.stringify([REC], null, 2))).toEqual([]));
  it("flags BOM, CR and extra trailing newlines as pipeline-rejected", () => {
    const r = parseLinksJson("﻿" + JSON.stringify([REC], null, 2).replaceAll("\n", "\r\n") + "\r\n\r\n");
    expect(r.issues.map((i) => i.code)).toEqual(["file/bom", "file/cr", "file/trailing-newlines"]);
    expect(r.pipelineRejectsBytes).toBe(true);
    expect(r.generatorRejectsFile).toBe(false);
    expect(r.records).toHaveLength(1);
  });
  it("finds a duplicate key that JSON.parse would hide", () => {
    expect(findDuplicateKey('[{"a":1,"b":{"a":2},"a":3}]')).toBe("a");
    expect(findDuplicateKey('[{"a":1},{"a":2}]')).toBeNull();
    expect(findDuplicateKey('[{"a":"x\\"y","b":"a"}]')).toBeNull();
  });
  it("rejects non-JSON and a Dicta-style map", () => {
    expect(parseLinksJson("[{").generatorRejectsFile).toBe(true);
    expect(codes('{"3":[{"start":1,"end":2,"refs":[]}]}')).toContain("file/not-array");
  });
});

describe("parseLinksJson — records", () => {
  it("one undecodable record makes the generator drop the WHOLE file; good records are still kept", () => {
    const r = parseLinksJson(JSON.stringify([REC, { ...REC, line_index_2: "2" }, { line_index_1: 3 }]));
    expect(r.generatorRejectsFile).toBe(true);
    expect(r.records).toHaveLength(1);
    expect(r.issues.filter((i) => i.index >= 0).map((i) => [i.index, i.code])).toEqual([
      [1, "record/not-number"], [2, "record/missing-field"], [2, "record/missing-field"], [2, "record/missing-field"],
    ]);
  });
  it('"Connection Type" with two n is ignored by the generator', () => {
    const { "Conection Type": _, ...rest } = REC;
    expect(codes(JSON.stringify([{ ...rest, "Connection Type": "commentary" }]))).toContain("record/double-n-type");
  });
  it("unknown type, linker, non-integer and below-1 indexes are warned about", () => {
    expect(codes(JSON.stringify([{ ...REC, "Conection Type": "sifrei mitsvot" }]))).toContain("record/unknown-type");
    expect(codes(JSON.stringify([{ ...REC, "Conection Type": "linker" }]))).toContain("record/linker-skipped");
    expect(codes(JSON.stringify([{ ...REC, line_index_1: 2.5 }]))).toContain("record/not-integer");
    expect(codes(JSON.stringify([{ ...REC, line_index_1: 0 }]))).toContain("record/index-below-1");
  });
});

const book = (title: string, extra: Partial<BookRef> = {}): BookRef => ({ key: `k:${title}`, title, origin: "otzaria", isBaseBook: false, ...extra });

describe("convert — 1-based file ↔ 0-based model", () => {
  const src = book("בראשית", { origin: "sefaria", isBaseBook: true });
  const tgt = book("רש״י על בראשית");
  const parse1 = (rec: object) => {
    const [r] = parseLinksJson(JSON.stringify([rec])).records;
    return recordToLink(r!, 0, src, (t) => (t === tgt.title ? tgt : null), "x");
  };
  it("converts indexes, ranges and the anchor (label from the LAST ' אות ')", () => {
    const { link } = parse1({ ...REC, line_index_2_end: 5, start: 6, end: 12, heRef_2: "שער אות א, סימן ב אות ג" });
    expect(link.source).toMatchObject({ line: 0 });
    expect(link.target).toMatchObject({ line: 1, end: 4, book: tgt });
    expect(link.anchor).toEqual({ rawStart: 6, rawEnd: 12, label: "ג" });
  });
  it("a reversed or degenerate range is dropped with a warning (generator ignores it)", () => {
    const { link, issues } = parse1({ ...REC, line_index_2: 5, line_index_2_end: 3 });
    expect(link.target.end).toBeUndefined();
    expect(issues.map((i) => i.code)).toContain("record/range-reversed");
    expect(parse1({ ...REC, line_index_2_end: 2 }).link.target.end).toBeUndefined();
  });
  it("an unknown target is kept as unresolved and reported", () => {
    const { link, issues } = parse1({ ...REC, path_2: "ספר שאינו.txt" });
    expect(link.target.book.origin).toBe("unknown");
    expect(issues.map((i) => i.code)).toContain("record/target-not-found");
  });
  it("a null or missing \"Conection Type\" is written back as it was, until a type is set", () => {
    // real library files: 259 have `"Conection Type": null` (MoreBooks/links/סידור אשכנז_links.json, live), 2 have
    // records without the key; both came back as `"Conection Type": ""`, rewriting an untouched file
    const base = { line_index_1: 2, heRef_2: "רש״י", path_2: "רש״י על בראשית.txt", line_index_2: 3 };
    for (const rec of [base, { ...base, "Conection Type": null }]) {
      const text = JSON.stringify([rec], null, 2);
      const { link } = recordToLink(parseLinksJson(text).records[0]!, 0, src, () => tgt, "f0");
      expect(serializeLinksJson([linkToRecord(link)])).toBe(text);
      expect(JSON.parse(serializeLinksJson([linkToRecord({ ...link, declaredType: "commentary" })]))[0]["Conection Type"]).toBe("commentary");
    }
  });
  it("new links get the canonical key order and a folder-less path_2", () => {
    const link: Link = { id: "n", status: "new", provenance: "user", source: { book: src, line: 2, end: 4 }, target: { book: tgt, line: 0 }, declaredType: "commentary", heRef2: "רש״י", anchor: { rawStart: 3 } };
    expect(serializeLinksJson([linkToRecord(link)])).toBe(
      JSON.stringify([{ line_index_1: 3, line_index_1_end: 5, heRef_2: "רש״י", path_2: "רש״י על בראשית.txt", line_index_2: 1, start: 3, "Conection Type": "commentary" }], null, 2),
    );
  });
});

describe("storedForm — generator orientation rules", () => {
  const bereshit = book("בראשית", { origin: "sefaria", isBaseBook: true });
  const rashi = book("רש״י על בראשית");
  const other = book("ספר כלשהו");
  const L = (from: BookRef, to: BookRef, declaredType: string) => ({ source: { book: from, line: 0 }, target: { book: to, line: 1 }, declaredType });

  it('"source" flips and is stored as COMMENTARY', () => {
    expect(storedForm(L(rashi, bereshit, "source"))).toMatchObject({ stored: "COMMENTARY", flipped: true, panel: "commentaries" });
  });
  it("a dependent type from a non-base book into a base book: flips when the title names the base, else OTHER", () => {
    expect(storedForm(L(rashi, bereshit, "commentary"))).toMatchObject({ stored: "COMMENTARY", flipped: true, downgraded: false });
    expect(storedForm(L(other, bereshit, "commentary"))).toMatchObject({ stored: "OTHER", flipped: false, downgraded: true, panel: "links" });
  });
  it("base → dependant stays as written", () => {
    expect(storedForm(L(bereshit, rashi, "commentary"))).toMatchObject({ stored: "COMMENTARY", flipped: false });
  });
  it("linker and Sefaria↔Sefaria records are skipped", () => {
    expect(storedForm(L(bereshit, rashi, "linker")).skipped).toBe("linker");
    expect(storedForm(L(bereshit, book("שמות", { origin: "sefaria" }), "reference")).skipped).toBe("sefaria-both");
  });
  it("unknown isBaseBook makes the decision uncertain", () => {
    expect(storedForm(L(book("א", { isBaseBook: undefined }), rashi, "commentary")).uncertain).toBe(true);
  });
  it("the same stored link from either file direction has one key (dedup on the stored shape)", () => {
    const fromRashi = { source: { book: rashi, line: 7 }, target: { book: bereshit, line: 3 }, declaredType: "source" };
    const fromBereshit = { source: { book: bereshit, line: 3 }, target: { book: rashi, line: 7 }, declaredType: "commentary" };
    expect(storedKey(fromRashi)).toBe(storedKey(fromBereshit));
  });
});
