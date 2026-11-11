import { describe, expect, it } from "vitest";
import { guessRecordsMapping, mappingGaps, parseRecords, recordsToLinksFiles, type RecordsMapping } from "../../../src/formats/records/records";
import { parseLinksJson } from "../../../src/formats/links-json/parse";

describe("links in someone else's layout", () => {
  it("reads a JSON array, an object holding one, JSON Lines and a sheet", () => {
    expect(parseRecords('[{"a":1,"b":"x"},{"a":2,"c":true}]', "x.json")).toEqual({ fields: ["a", "b", "c"], rows: [{ a: "1", b: "x" }, { a: "2", c: "true" }], layout: "json" });
    expect(parseRecords('{"meta":1,"links":[{"a":1}]}', "x.json")!.rows).toEqual([{ a: "1" }]);
    expect(parseRecords('{"a":1}\n{"a":2}\n', "x.jsonl")!.layout).toBe("jsonl");
    expect(parseRecords("from,to\n1,2\n", "x.csv")!.rows).toEqual([{ from: "1", to: "2" }]);
    expect(parseRecords('{"a":1}', "x.json")).toBeNull(); // no array of records
    expect(parseRecords("just text", "x.txt")).toBeNull();
  });

  it("nested values are not offered; a key named __proto__ stays data", () => {
    const t = parseRecords('[{"a":{"x":1},"b":2,"__proto__":"p"}]', "x.json")!;
    expect(t.fields).toEqual(["b", "__proto__"]);
    expect(Object.getPrototypeOf(t.rows[0])).toBe(Object.prototype);
  });

  it("guesses fields by name, Hebrew too, and notices 0-based files", () => {
    const t = parseRecords("ספר מקור,source_line,target_book,to_line,type\nא,0,ב,3,commentary\n", "x.csv")!;
    const m = guessRecordsMapping(t);
    expect(m).toMatchObject({ source: { field: "ספר מקור" }, sourceLine: "source_line", targetTitle: "target_book", targetLine: "to_line", type: { field: "type" }, base: 0 });
    expect(mappingGaps(m)).toEqual([]);
    expect(mappingGaps(guessRecordsMapping(parseRecords("x,y\n1,2", "a.csv")!))).toEqual(["שורה בספר המקור", "שורה בספר היעד", "ספר היעד (שם או נתיב)"]);
  });

  it("converts to library records per source book, read back by the links-file parser", () => {
    const t = parseRecords(JSON.stringify([
      { from: "פירוש א", l1: 0, to: "בראשית", l2: 2, kind: "commentary" },
      { from: "פירוש א", l1: 4, to: "בראשית", l2: 9, kind: "commentary" },
      { from: "פירוש ב", l1: 1, to: "שמות.txt", l2: 0, kind: "reference" },
    ]), "links.json")!;
    const m: RecordsMapping = { source: { field: "from" }, sourceLine: "l1", targetTitle: "to", targetLine: "l2", type: { field: "kind" }, base: 0 };
    const r = recordsToLinksFiles(t, m, "links.json");
    expect(r.problems).toEqual([]);
    expect(r.files.map((f) => [f.sourceTitle, f.rows])).toEqual([["פירוש א", 2], ["פירוש ב", 1]]);
    const recs = parseLinksJson(r.files[0]!.text).records;
    expect(recs[0]).toMatchObject({ line_index_1: 1, heRef_2: "בראשית", path_2: "בראשית.txt", line_index_2: 3, connectionType: "commentary" });
    expect(parseLinksJson(r.files[1]!.text).records[0]).toMatchObject({ path_2: "שמות.txt", line_index_2: 1 });
  });

  it("bad rows are reported by number and skipped; the source can come from the file name", () => {
    const t = parseRecords("a,b,c\n1,2,ספר\nx,2,ספר\n,3,ספר\n4,5,\n", "פירוש_links.csv")!;
    const m: RecordsMapping = { source: { fromFileName: true }, sourceLine: "a", targetTitle: "c", targetLine: "b", type: { fixed: "reference" }, base: 1 };
    const r = recordsToLinksFiles(t, m, "פירוש_links.csv");
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ sourceTitle: "פירוש", rows: 1 });
    expect(r.problems).toEqual(['רשומה 2: שורת המקור "x" אינו מספר שלם.', "רשומה 3: חסרה שורת המקור.", "רשומה 4: ספר היעד ריק."]);
  });
});
