import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import type { ValidationContext } from "../../../src/core/links/validate";
import { recordToLink } from "../../../src/formats/links-json/convert";
import { planExport } from "../../../src/formats/links-json/export";
import { detectLayout, joinElements, stringifyElement, stringifyInLayout, type JsonLayout } from "../../../src/formats/links-json/layout";
import { parseLinksJson } from "../../../src/formats/links-json/parse";
import { parseProject, serializeProject } from "../../../src/projects/project-format";

/*
 * Review C9: an imported library file the user did not touch must come back byte-identical. The model
 * keeps numbers as numbers, so `126.0` (Python json.dump of floats — 459,381 such values in 353
 * library files) came back as `126`, `"line_index_1": 0` as 1, `"start": 4.5` as 4, and an `_end`
 * that is not after its start disappeared. A record whose spelling the writer would change keeps
 * its own text, and that text is written back while the link still means the same record.
 */
const book = (title: string): BookRef => ({ key: `k:${title}`, title, origin: "otzaria" });
const SRC = book("סידור אשכנז");
const resolve = (t: string) => book(t);
const ctx: ValidationContext = { lineCount: () => 10_000, line: () => undefined };

// Python json.dump(…, indent=4, ensure_ascii=False) of float line numbers, plus a final newline
const PYTHON = `[
    {
        "line_index_1": 126.0,
        "heRef_2": "בראשית א, א",
        "path_2": "בראשית.txt",
        "line_index_2": 1.0,
        "Conection Type": "commentary"
    },
    {
        "line_index_1": 0,
        "line_index_1_end": 0,
        "heRef_2": "בראשית א, ב",
        "path_2": "בראשית.txt",
        "line_index_2": 2,
        "start": 4.5,
        "end": 9.0,
        "Conection Type": null
    },
    {
        "line_index_1": 7,
        "heRef_2": "בראשית א, ג",
        "path_2": "בראשית.txt",
        "line_index_2": 3,
        "Conection Type": "reference"
    }
]
`;

function importFile(text: string): Link[] {
  return parseLinksJson(text).records.map((r, i) => recordToLink(r, i, SRC, resolve, `file:${i}`).link);
}
const exportOf = (links: readonly Link[], text: string) => planExport(links, ctx, { layouts: () => detectLayout(text) }).files[0]!.text;

describe("an untouched imported file is written back byte-identical (review C9)", () => {
  it("float spellings, line_index 0, a fractional start and an _end that is not after its start", () => {
    expect(exportOf(importFile(PYTHON), PYTHON)).toBe(PYTHON);
  });

  it("only records whose spelling would change keep their text", () => {
    const links = importFile(PYTHON);
    expect(links.map((l) => l.fileText !== undefined)).toEqual([true, true, false]);
  });

  it("an edited record is written anew; its neighbours keep their bytes", () => {
    const links = importFile(PYTHON);
    const edited: Link = { ...links[0]!, status: "edited", target: { ...links[0]!.target, line: 4 } };
    const out = exportOf([edited, links[1]!, links[2]!], PYTHON);
    expect(out).toBe(PYTHON.replace('"line_index_1": 126.0', '"line_index_1": 126').replace('"line_index_2": 1.0', '"line_index_2": 5'));
  });

  it("a deleted record is gone, and the rest is unchanged", () => {
    const links = importFile(PYTHON);
    const out = exportOf([links[0]!, { ...links[1]!, status: "deleted" }, links[2]!], PYTHON);
    expect(JSON.parse(out)).toHaveLength(2);
    expect(out).toContain('"line_index_1": 126.0');
  });

  it("text that no longer means the link is never written (stale or forged fileText)", () => {
    const links = importFile(PYTHON);
    const forged: Link = { ...links[2]!, fileText: links[0]!.fileText! }; // another record's bytes
    const odd: Link = { ...links[2]!, fileText: '{"line_index_1": 7.0, "heRef_2": "בראשית א, ג", "path_2": "בראשית.txt", "line_index_2": 3, "Conection Type": "reference", "extra": 1}' };
    for (const l of [forged, odd, { ...links[2]!, fileText: "{}\n]\n[{" }, { ...links[2]!, fileText: '{"line_index_1": 7.0, "line_index_1": 7.0}' }]) {
      const out = exportOf([links[0]!, links[1]!, l], PYTHON);
      expect(out).toBe(PYTHON);
    }
  });

  it("a project saved and opened again keeps the text", () => {
    const links = importFile(PYTHON);
    const text = serializeProject({ sources: [], links, rejectedSuggestions: [], view: { source: null, target: null } }, "test");
    const back = parseProject(text, (b) => book(b.title));
    expect(back.links.map((l) => l.fileText)).toEqual(links.map((l) => l.fileText));
    expect(exportOf(back.links, PYTHON)).toBe(PYTHON);
  });

  it("a file whose line numbers are ALL floats: the layout writes them so, no record keeps its text", () => {
    // 351 of the 352 float files of the library are uniform like this; only סידור אשכנז mixes 126.0 and 126
    const floats = PYTHON.replace('"line_index_1": 0,', '"line_index_1": 0.0,').replace('"line_index_1": 7,', '"line_index_1": 7.0,').replace('"line_index_2": 2,', '"line_index_2": 2.0,').replace('"line_index_2": 3,', '"line_index_2": 3.0,');
    const layout = detectLayout(floats);
    expect(layout.floatKeys).toEqual(["line_index_1", "line_index_2", "end"]);
    const links = importFile(floats);
    expect(links.map((l) => l.fileText !== undefined)).toEqual([false, true, false]); // only the record with 0.0 / 4.5 / a dropped _end
    expect(exportOf(links, floats)).toBe(floats);
    // a new link in that file is written in the file's own style
    const added: Link = { ...links[2]!, id: "n1", status: "new", provenance: "user", source: { book: SRC, line: 40 }, fileIndex: undefined, keyOrder: undefined };
    expect(exportOf([...links, added], floats)).toContain('"line_index_1": 41.0');
    // and the layout survives a project round trip
    const p = parseProject(serializeProject({ sources: [], links: [], rejectedSuggestions: [], view: { source: null, target: null }, libraryFiles: [{ title: "x", records: 3, hash: "h", layout }] }, "test"), (b) => book(b.title));
    expect(p.libraryFiles[0]!.layout).toEqual(layout);
  });

  it("escapes JSON.stringify would not write (\\/, \\u in a UTF-8 file) keep their record's text", () => {
    const text = '[\n  {\n    "line_index_1": 1,\n    "heRef_2": "a\\/b \\u05d0",\n    "path_2": "x.txt",\n    "line_index_2": 2,\n    "Conection Type": "reference"\n  },\n  {\n    "line_index_1": 3,\n    "heRef_2": "שו\\"ת",\n    "path_2": "x.txt",\n    "line_index_2": 4,\n    "Conection Type": "reference"\n  }\n]';
    const links = importFile(text);
    expect(links.map((l) => l.fileText !== undefined)).toEqual([true, false]);
    expect(exportOf(links, text)).toBe(text);
  });

  it("a nested anchor_context written compactly inside an indented file (tashmaToOtzaria/משנה ברורה)", () => {
    const text = '[\n {\n  "line_index_1": 30,\n  "anchor_context": {"before":"א","after":"ב"},\n  "heRef_2": "x",\n  "path_2": "x.txt",\n  "line_index_2": 2,\n  "Conection Type": "commentary"\n }\n]\n';
    const links = importFile(text);
    expect(links[0]!.fileText).toBeDefined();
    expect(exportOf(links, text)).toBe(text);
  });

  it("a string value that looks like a float key is never rewritten", () => {
    const layout: JsonLayout = { indent: "  ", finalNewline: false, escapeNonAscii: false, floatKeys: ["line_index_1"] };
    expect(stringifyElement({ line_index_1: 5, heRef_2: '"line_index_1": 7,' }, layout)).toBe('{\n    "line_index_1": 5.0,\n    "heRef_2": "\\"line_index_1\\": 7,"\n  }');
  });

  it.each<[string, JsonLayout]>([
    ["two spaces", { indent: "  ", finalNewline: false, escapeNonAscii: false }],
    ["tab, escaped", { indent: "\t", finalNewline: true, escapeNonAscii: "upper" }],
    ["one line", { indent: "", finalNewline: false, escapeNonAscii: false }],
    ["one line, Python separators", { indent: "", spaced: true, finalNewline: true, escapeNonAscii: "lower" }],
  ])("element by element is the same text as the whole array (%s)", (_, layout) => {
    const values = [{ a: 1, b: "א, ב: ג", c: [1, { d: null }] }, { e: "𝔸" }, {}];
    expect(joinElements(values.map((v) => stringifyElement(v, layout)), layout)).toBe(stringifyInLayout(values, layout));
    expect(joinElements([], layout)).toBe(stringifyInLayout([], layout));
  });
});
