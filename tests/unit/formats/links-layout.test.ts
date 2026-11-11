import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, detectLayout, stringifyInLayout } from "../../../src/formats/links-json/layout";
import { parseLinksJson } from "../../../src/formats/links-json/parse";
import { serializeLinksJson } from "../../../src/formats/links-json/serialize";

const recs = [{ line_index_1: 1, heRef_2: "בראשית א, א", path_2: "בראשית.txt", line_index_2: 2, "Conection Type": "commentary" }];
/** what Python's json.dump(…, indent=4) writes with ensure_ascii, plus the final newline most scripts add */
const python = JSON.stringify(recs, null, 4).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n";

describe("links-file layout", () => {
  it("detects the common layouts", () => {
    expect(detectLayout(JSON.stringify(recs, null, 2))).toEqual(DEFAULT_LAYOUT);
    expect(detectLayout(python)).toEqual({ indent: "    ", finalNewline: true, escapeNonAscii: "lower" });
    expect(detectLayout(JSON.stringify(recs, null, "\t") + "\n").indent).toBe("\t");
    expect(detectLayout("[]")).toEqual(DEFAULT_LAYOUT);
    expect(detectLayout('[\n  {"a": "\\u05D0"}\n]').escapeNonAscii).toBe("upper");
    // an escaped quote or control character is not "ensure_ascii"
    expect(detectLayout('[\n  {"a": "x\\u0022y"}\n]').escapeNonAscii).toBe(false);
    // raw Hebrew next to an escape: the file is UTF-8, the escape was in the data
    expect(detectLayout('[\n  {"a": "א\\u05d0"}\n]').escapeNonAscii).toBe(false);
  });

  it("an untouched file is written back byte-identical, in each layout", () => {
    for (const text of [JSON.stringify(recs, null, 2), python, JSON.stringify(recs, null, "\t") + "\n"]) {
      expect(serializeLinksJson(parseLinksJson(text).records, detectLayout(text))).toBe(text);
    }
  });

  it("one-line files: compact, and Python's spaced separators (never inside strings)", () => {
    const compact = JSON.stringify(recs);
    expect(detectLayout(compact)).toEqual({ indent: "", finalNewline: false, escapeNonAscii: false });
    for (const text of [compact, compact + "\n"]) expect(serializeLinksJson(parseLinksJson(text).records, detectLayout(text))).toBe(text);
    const spaced = '[{"line_index_1": 1, "heRef_2": "a, b: c", "path_2": "x.txt", "line_index_2": 2, "Conection Type": "commentary"}]';
    const layout = detectLayout(spaced);
    expect(layout).toMatchObject({ indent: "", spaced: true });
    expect(serializeLinksJson(parseLinksJson(spaced).records, layout)).toBe(spaced);
  });

  it("escapes per UTF-16 code unit, as Python does for characters outside the BMP", () => {
    expect(stringifyInLayout(["𝔸"], { indent: "", finalNewline: false, escapeNonAscii: "lower" })).toBe('["\\ud835\\udd38"]');
  });
});
