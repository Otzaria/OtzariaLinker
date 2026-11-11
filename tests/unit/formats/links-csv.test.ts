import { describe, expect, it } from "vitest";
import { parseDelimited, parseLinksCsv } from "../../../src/formats/links-csv/parse";
import { parseLinksJson } from "../../../src/formats/links-json/parse";

describe("links CSV/TSV", () => {
  it("RFC 4180 quoting: commas, quotes and line breaks inside fields", () => {
    expect(parseDelimited('a,"b,c","say ""hi""","x\ny"\r\n1,2,3,4', ",")).toEqual([["a", "b,c", 'say "hi"', "x\ny"], ["1", "2", "3", "4"]]);
  });

  it("rows become a links file per source book, read by the same parser", () => {
    const csv = ["source_title,line_index_1,heRef_2,path_2,line_index_2,Conection Type", 'פירוש א,2,"בראשית א, א",בראשית.txt,3,source', "פירוש ב,5,בראשית ב,בראשית.txt,7,commentary"].join("\n");
    const r = parseLinksCsv(csv, "links.csv");
    expect(r.problems).toEqual([]);
    expect(r.files.map((f) => f.sourceTitle)).toEqual(["פירוש א", "פירוש ב"]);
    const recs = parseLinksJson(r.files[0]!.text).records;
    expect(recs[0]).toMatchObject({ line_index_1: 2, heRef_2: "בראשית א, א", line_index_2: 3, connectionType: "source" });
  });

  it("100,000 rows of one book are grouped in linear time", () => {
    // regression: the rows of a book were copied into a new list for every row (quadratic)
    const rows = Array.from({ length: 100_000 }, (_, i) => `${i + 1},ב ${i},ב.txt,${i + 1},reference`);
    const t0 = performance.now();
    const r = parseLinksCsv(["line_index_1,heRef_2,path_2,line_index_2,Conection Type", ...rows].join("\n"), "א_links.csv");
    expect(r.files[0]!.rows).toBe(100_000);
    expect(performance.now() - t0).toBeLessThan(15_000);
  }, 60_000);
  it("the source can come from the file name; a TSV is detected", () => {
    const tsv = ["line_index_1\theRef_2\tpath_2\tline_index_2\ttype", "2\tא\tב.txt\t3\treference"].join("\n");
    expect(parseLinksCsv(tsv, "ספר_links.tsv").files[0]!.sourceTitle).toBe("ספר");
  });

  it("missing columns are named", () => {
    expect(parseLinksCsv("a,b\n1,2", "x_links.csv").problems[0]).toContain("line_index_1");
  });
});
