import { describe, expect, it } from "vitest";
import type { AltTocBook } from "../../../src/core/alt-toc/model";
import { planAltTocExport } from "../../../src/formats/alt-toc/export";
import { altTocFileName, parseAltTocJson, serializeAltToc, titleFromAltTocFileName } from "../../../src/formats/alt-toc/file";

/** The example of the library doc "קישורים וכותרות" §6 (Otzaria-side alt_toc file). */
const DOC_EXAMPLE = `[
  { "key": "Parasha", "heTitle": "פרשה",
    "nodes": [
      { "heTitle": "בראשית", "line": 1, "children": [
          { "heTitle": "עליה א", "line": 1 },
          { "heTitle": "עליה ב", "line": 36 }
      ]},
      { "heTitle": "נח", "line": 154 }
    ]}
]`;

describe("alt_toc file names", () => {
  it("<title>_alt_toc.json, title taken back from a path", () => {
    expect(altTocFileName("בראשית")).toBe("בראשית_alt_toc.json");
    expect(titleFromAltTocFileName("x/alt_toc/רש\"י על בראשית_alt_toc.json")).toBe('רש"י על בראשית');
    expect(titleFromAltTocFileName("בראשית_links.json")).toBeNull();
    expect(titleFromAltTocFileName("_alt_toc.json")).toBeNull();
  });
});

describe("parseAltTocJson — the generator's decoding rules", () => {
  it("reads the documented example into flat entries", () => {
    const r = parseAltTocJson(DOC_EXAMPLE);
    expect(r.issues).toEqual([]);
    expect(r.generatorRejectsFile).toBe(false);
    expect(r.structures).toEqual([
      { key: "Parasha", heTitle: "פרשה", entries: [{ heTitle: "בראשית", line: 1, level: 0 }, { heTitle: "עליה א", line: 1, level: 1 }, { heTitle: "עליה ב", line: 36, level: 1 }, { heTitle: "נח", line: 154, level: 0 }] },
    ]);
  });

  it("strips a BOM, ignores unknown keys, accepts null title/heTitle and missing nodes/children", () => {
    const r = parseAltTocJson('﻿[{"key":"A","title":null,"heTitle":null,"extra":1},{"key":"B","nodes":[{"heTitle":"x","line":2,"note":"y"}]}]');
    expect(r.issues).toEqual([]);
    expect(r.structures).toEqual([{ key: "A", entries: [] }, { key: "B", entries: [{ heTitle: "x", line: 2, level: 0 }] }]);
  });

  it("truncates a fractional line, as node.line.toInt() does, with a warning", () => {
    const r = parseAltTocJson('[{"key":"A","nodes":[{"heTitle":"x","line":3.9}]}]');
    expect(r.structures[0]!.entries[0]!.line).toBe(3);
    expect(r.issues.map((i) => i.code)).toEqual(["alt-toc/line-fraction"]);
    expect(r.generatorRejectsFile).toBe(false);
  });

  it("a missing required field makes the generator skip the WHOLE file", () => {
    for (const bad of ['[{"nodes":[]}]', '[{"key":"A","nodes":[{"line":1}]}]', '[{"key":"A","nodes":[{"heTitle":"x"}]}]', '[{"key":"A","nodes":[{"heTitle":"x","line":"1"}]}]', '{"key":"A"}', "not json", '[{"key":"A","nodes":{}}]']) {
      expect(parseAltTocJson(bad).generatorRejectsFile, bad).toBe(true);
    }
  });
});

describe("serializeAltToc", () => {
  it("writes key, title, heTitle, nodes in that order; children only when present; 2-space indent, no BOM", () => {
    const text = serializeAltToc([{ key: "Parasha", heTitle: "פרשה", title: "Parashot", entries: [{ heTitle: "בראשית", line: 1, level: 0 }, { heTitle: "עליה א", line: 1, level: 1 }] }]);
    expect(text).toBe(
      JSON.stringify([{ key: "Parasha", title: "Parashot", heTitle: "פרשה", nodes: [{ heTitle: "בראשית", line: 1, children: [{ heTitle: "עליה א", line: 1 }] }] }], null, 2),
    );
    expect(text.includes("\r")).toBe(false);
  });

  it("round-trips the documented example (same JSON, normalized layout)", () => {
    const again = serializeAltToc(parseAltTocJson(DOC_EXAMPLE).structures);
    expect(JSON.parse(again)).toEqual(JSON.parse(DOC_EXAMPLE));
    expect(serializeAltToc(parseAltTocJson(again).structures)).toBe(again);
  });

  it("leaves out empty structures; no structures at all is [] (the generator then deletes the book's structures)", () => {
    expect(JSON.parse(serializeAltToc([{ key: "A", entries: [] }, { key: "B", entries: [{ heTitle: "x", line: 1, level: 0 }] }])).map((s: { key: string }) => s.key)).toEqual(["B"]);
    expect(serializeAltToc([{ key: "A", entries: [] }])).toBe("[]");
  });
});

describe("planAltTocExport", () => {
  const ok = { key: "Parasha", heTitle: "פרשה", entries: [{ heTitle: "בראשית", line: 1, level: 0 }, { heTitle: "עליה א", line: 1, level: 1 }] };
  const books: AltTocBook[] = [
    { title: "ג", origin: "user", structures: [ok] },
    { title: "א", origin: "user", structures: [{ ...ok, entries: [{ heTitle: "x", line: 999, level: 0 }] }] },
    { title: "ב", origin: "db", structures: [] },
    { title: "ד", origin: "user", structures: [{ key: "Empty", heTitle: "ריק", entries: [] }] },
  ];
  const plan = planAltTocExport(books, (t) => (t === "א" ? { lineCount: 10 } : {}));

  it("writes clean books, sorted; a book with an error is held back whole", () => {
    expect(plan.files.map((f) => f.name)).toEqual(["ב_alt_toc.json", "ג_alt_toc.json"]);
    expect(plan.heldBack.map((b) => b.title)).toEqual(["א"]);
    expect(plan.heldBack[0]!.problems.map((p) => p.code)).toEqual(["alt-toc/line-out-of-range"]);
  });

  it("an emptied book that came from the library is written as [] (clears it); a user's empty list writes nothing", () => {
    expect(plan.files[0]).toMatchObject({ title: "ב", text: "[]", clears: true, structures: 0 });
    expect(plan.files[1]).toMatchObject({ title: "ג", clears: false, structures: 1, nodes: 2 });
    expect(plan.files.some((f) => f.title === "ד")).toBe(false);
  });
});
