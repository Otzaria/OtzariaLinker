import { describe, expect, it } from "vitest";
import { parseLinksCsv } from "../../../src/formats/links-csv/parse";
import { parseLinksJson } from "../../../src/formats/links-json/parse";
import { serializeLinksJson } from "../../../src/formats/links-json/serialize";
import { CitationRun } from "../../../src/linking/automatic/citations";

/*
 * Keys named like Object.prototype members are data (SECURITY.md §6) — security review A9/A10.
 */
describe("a __proto__ key of a library record", () => {
  it("is kept as data and written back byte-identical (it used to be dropped on export)", () => {
    for (const v of ['"x"', '{\n      "a": 1\n    }']) {
      const text = `[\n  {\n    "line_index_1": 1,\n    "heRef_2": "h",\n    "path_2": "b.txt",\n    "line_index_2": 1,\n    "Conection Type": "reference",\n    "__proto__": ${v}\n  }\n]`;
      const p = parseLinksJson(text);
      expect(serializeLinksJson(p.records)).toBe(text);
    }
  });

  it("a __proto__ column of a links sheet stays a field of the record", () => {
    const r = parseLinksCsv("line_index_1,heRef_2,path_2,line_index_2,Conection Type,__proto__\n1,h,b.txt,1,reference,x\n", "א_links.csv");
    expect(r.problems).toEqual([]);
    const rec = JSON.parse(r.files[0]!.text)[0];
    expect(Object.keys(rec)).toContain("__proto__");
  });
});

describe("citations: a book titled like an Object.prototype member", () => {
  it("does not throw", () => {
    for (const title of ["constructor", "toString", "__proto__"])
      expect(() => CitationRun.fromCatalog({ key: "s:1", title, origin: "otzaria" }, [])).not.toThrow();
  });
});
