import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { entriesFromHeadings, numberInGematria } from "../../../src/core/alt-toc/edit";
import { entriesToNodes, isSefariaSourceName, nodesToEntries, rowsToEntries, validateAltToc, writtenStructures, type AltTocEntry, type AltTocStructure } from "../../../src/core/alt-toc/model";

const e = (heTitle: string, line: number, level: number): AltTocEntry => ({ heTitle, line, level });
const codes = (s: AltTocStructure[], ctx = {}) => validateAltToc(s, ctx).map((p) => p.code);

describe("alt_toc: flat entries ↔ the file's nested nodes", () => {
  it("version 3's regression case: two roots, two children under the first", () => {
    // legacy/OtzariaLinker-v3.html self-test "מבנה אלטרנטיבי: שני שורשים, שני ילדים תחת הראשון"
    const nodes = entriesToNodes([e("בראשית", 1, 0), e("עליה א", 1, 1), e("עליה ב", 36, 1), e("נח", 154, 0)]);
    expect(nodes).toEqual([
      { heTitle: "בראשית", line: 1, children: [{ heTitle: "עליה א", line: 1 }, { heTitle: "עליה ב", line: 36 }] },
      { heTitle: "נח", line: 154 },
    ]);
  });

  it("a level jump nests under the nearest shallower entry; a leading deep entry becomes a root", () => {
    expect(entriesToNodes([e("א", 1, 0), e("ב", 2, 3), e("ג", 3, 1)])).toEqual([{ heTitle: "א", line: 1, children: [{ heTitle: "ב", line: 2 }, { heTitle: "ג", line: 3 }] }]);
    expect(entriesToNodes([e("א", 1, 2), e("ב", 2, 0)])).toEqual([{ heTitle: "א", line: 1 }, { heTitle: "ב", line: 2 }]);
  });

  it("nodes → entries → nodes is the identity (any depth)", () => {
    type N = { heTitle: string; line: number; children?: N[] };
    const node: fc.Memo<N> = fc.memo((d) =>
      fc.record({ heTitle: fc.string({ minLength: 1, maxLength: 4 }), line: fc.integer({ min: 1, max: 999 }), children: d > 1 ? fc.option(fc.array(node(d - 1), { minLength: 1, maxLength: 3 }), { nil: undefined }) : fc.constant(undefined) }).map((n) => (n.children ? n : { heTitle: n.heTitle, line: n.line })),
    );
    fc.assert(fc.property(fc.array(node(4), { maxLength: 5 }), (nodes) => void expect(entriesToNodes(nodesToEntries(nodes))).toEqual(nodes)));
  });
});

describe("alt_toc: database rows → entries", () => {
  it("orders siblings by row id, nests by parentId, levels by depth", () => {
    const { entries, skipped } = rowsToEntries([
      { id: 9, parentId: 1, line: 36, text: "עליה ב" },
      { id: 1, parentId: null, line: 1, text: "בראשית" },
      { id: 5, parentId: 1, line: 1, text: "עליה א" },
      { id: 20, parentId: null, line: 154, text: "נח" },
    ]);
    expect(entries).toEqual([e("בראשית", 1, 0), e("עליה א", 1, 1), e("עליה ב", 36, 1), e("נח", 154, 0)]);
    expect(skipped).toBe(0);
  });

  it("a row without a line is skipped and its children move up; a parent missing from the rows makes a root", () => {
    const { entries, skipped } = rowsToEntries([
      { id: 1, parentId: null, line: null, text: "חסר" },
      { id: 2, parentId: 1, line: 5, text: "ילד" },
      { id: 3, parentId: 777, line: 9, text: "יתום" },
    ]);
    expect(entries).toEqual([e("ילד", 5, 0), e("יתום", 9, 0)]);
    expect(skipped).toBe(1);
  });

  it("survives a parent cycle in a damaged database", () => {
    expect(rowsToEntries([{ id: 1, parentId: 2, line: 1, text: "א" }, { id: 2, parentId: 1, line: 2, text: "ב" }]).entries).toEqual([]);
  });
});

describe("alt_toc: validation = what the generator would do", () => {
  const ok: AltTocStructure = { key: "Parasha", heTitle: "פרשה", entries: [e("בראשית", 1, 0), e("עליה א", 1, 1), e("עליה ב", 36, 1), e("נח", 154, 0)] };

  it("a clean structure has no problems; siblings may share a line (library doc §6)", () => {
    expect(validateAltToc([ok], { lineCount: 500 })).toEqual([]);
    expect(codes([{ ...ok, entries: [e("דף ב.", 3, 0), e("דף ב:", 3, 0)] }])).toEqual([]);
  });

  it("errors: missing/duplicate key, missing node title, bad line or level, line after the end or not in the database", () => {
    expect(codes([{ ...ok, key: " " }])).toContain("alt-toc/key-missing");
    expect(codes([ok, { ...ok }])).toContain("alt-toc/key-duplicate");
    expect(codes([{ ...ok, entries: [e(" ", 1, 0)] }])).toContain("alt-toc/title-missing");
    expect(codes([{ ...ok, entries: [e("א", 0, 0)] }])).toContain("alt-toc/bad-line");
    expect(codes([{ ...ok, entries: [e("א", 1.5, 0)] }])).toContain("alt-toc/bad-line");
    expect(codes([{ ...ok, entries: [e("א", 1, -1)] }])).toContain("alt-toc/bad-level");
    expect(codes([ok], { lineCount: 100 })).toContain("alt-toc/line-out-of-range");
    expect(codes([ok], { lineExists: (i: number) => i !== 35 })).toContain("alt-toc/line-not-in-db");
    for (const p of validateAltToc([ok], { lineCount: 100 })) if (p.code === "alt-toc/line-out-of-range") expect(p).toMatchObject({ severity: "error", structure: 0, entry: 3 });
  });

  it("warnings: Sefaria book, automatic or non-English key, Topic, no display name, empty, level jump, order", () => {
    expect(codes([ok], { sefaria: true })).toEqual(["alt-toc/sefaria-book"]);
    expect(codes([{ ...ok, key: "Chapters" }])).toEqual(["alt-toc/automatic-key"]);
    expect(validateAltToc([{ ...ok, key: "Topic" }])[0]!.message).toContain("גוף הספר");
    expect(codes([{ ...ok, key: "פרשות" }])).toEqual(["alt-toc/key-not-english"]);
    expect(codes([{ ...ok, key: " Parasha" }])).toContain("alt-toc/key-spaces");
    expect(codes([{ key: "Parasha", entries: ok.entries }])).toEqual(["alt-toc/no-display-name"]);
    expect(codes([{ ...ok, entries: [] }])).toEqual(["alt-toc/empty"]);
    expect(codes([{ ...ok, entries: [e("א", 1, 0), e("ב", 2, 2)] }])).toEqual(["alt-toc/level-jump"]);
    expect(codes([{ ...ok, entries: [e("א", 1, 1)] }])).toEqual(["alt-toc/level-jump"]);
    expect(codes([{ ...ok, entries: [e("א", 10, 0), e("ב", 5, 0)] }])).toEqual(["alt-toc/out-of-order"]);
    expect(codes([{ ...ok, entries: [e("א", 10, 0), e("ב", 5, 1)] }])).toEqual(["alt-toc/before-parent"]);
    // a new parent starts a new sibling sequence: no out-of-order across parents
    expect(codes([{ ...ok, entries: [e("א", 1, 0), e("א1", 50, 1), e("ב", 60, 0), e("ב1", 61, 1)] }])).toEqual([]);
  });

  it("only non-empty structures are written", () => {
    expect(writtenStructures([ok, { key: "X", entries: [] }]).map((s) => s.key)).toEqual(["Parasha"]);
  });

  it("Sefaria by source name, as the generator decides (contains 'sefaria', any case)", () => {
    expect(isSefariaSourceName("Sefaria")).toBe(true);
    expect(isSefariaSourceName("sefariaToOtzaria")).toBe(true);
    expect(isSefariaSourceName("DictaToOtzaria")).toBe(false);
    expect(isSefariaSourceName(undefined)).toBe(false);
  });
});

describe("alt_toc editing helpers (version 3)", () => {
  it("fill from headings: the shallowest heading level becomes 0, lines become 1-based", () => {
    expect(entriesFromHeadings([{ line: 0, level: 2, text: "פרק א" }, { line: 4, level: 3, text: "סעיף א" }, { line: 9, level: 2, text: "פרק ב" }])).toEqual([e("פרק א", 1, 0), e("סעיף א", 5, 1), e("פרק ב", 10, 0)]);
    expect(entriesFromHeadings([])).toEqual([]);
  });

  it("gematria numbering: base word + running numeral, restarting under every parent; level 0 untouched", () => {
    const r = numberInGematria([e("בראשית", 1, 0), e("x", 1, 1), e("x", 2, 1), e("y", 3, 2), e("x", 4, 1), e("נח", 9, 0), e("x", 9, 1)], "עליה");
    expect(r.entries.map((x) => x.heTitle)).toEqual(["בראשית", "עליה א", "עליה ב", "עליה א", "עליה ג", "נח", "עליה א"]);
    expect(r.changed).toBe(5);
    const many = numberInGematria([e("p", 1, 0), ...Array.from({ length: 16 }, (_, i) => e("x", i + 2, 1))], "עליה").entries;
    expect(many.at(-2)!.heTitle).toBe("עליה טו");
    expect(many.at(-1)!.heTitle).toBe("עליה טז");
    expect(numberInGematria([e("p", 1, 0)], "עליה").changed).toBe(0);
  });
});
