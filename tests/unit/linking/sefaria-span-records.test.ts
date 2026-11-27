import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { firstRefIn, refBlockByHeRef, refBlockOf, SPAN_EACH_LINE_MAX, withoutRange } from "../../../src/core/links/sefaria-owned";
import { headingLevel } from "../../../src/core/text/html";
import { recordsOf, runEngine, type EngineBook } from "../../../src/linking/automatic";

/*
 * How a span cut on a Sefaria side is written (core/links/sefaria-owned.ts withoutRange; LIBRARY_BENCHMARK.md
 * §0.8, the owner's decision of 2026-11-16): a record per line that can carry a ref_2 for a span of at most
 * SPAN_EACH_LINE_MAX lines; beyond that one record, to the first such line ("firstRef") — never to the
 * siman's name line of a Shulchan Aruch-style base, which has no heRef; and as before when no line can.
 */
const BASE: BookRef = { key: "db:1", title: "בראשית", origin: "sefaria" };
const COMM: BookRef = { key: "s1:ביאור חדש על בראשית.txt", title: "ביאור חדש על בראשית", origin: "otzaria" };
const HEB = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "יא", "יב", "יג", "יד", "טו", "טז", "יז", "יח", "יט", "כ", "כא", "כב", "כג", "כד", "כה"];

/** a chapter as the database has it: its heading, a name line without a heRef (as a Shulchan Aruch siman's), then `n` verses with heRefs */
function chapter(n: number, perek: number, name = true): { text: string; heRef: string | null }[] {
  return [
    { text: `<h2>פרק ${HEB[perek - 1]}</h2>`, heRef: null },
    ...(name ? [{ text: `דיני הפרק ה${HEB[perek - 1]}`, heRef: null }] : []),
    ...Array.from({ length: n }, (_, i) => ({ text: `פסוק ${HEB[i]} של פרק ${HEB[perek - 1]} ויאמר אלהים דבר ${i}`, heRef: `בראשית, ${HEB[perek - 1]}, ${HEB[i]}` })),
  ];
}
const asBook = (book: BookRef, rows: readonly { text: string; heRef?: string | null }[]): EngineBook => ({
  book,
  lines: rows.map((r, index) => ({ index, text: r.text, heading: headingLevel(r.text), heRef: r.heRef ?? null })),
});
// line 0: title; פרק א: heading 1, name 2, verses 3..6; פרק ב: heading 7, name 8, verses 9..33 (a span of 26 lines)
const base = asBook(BASE, [{ text: "<h1>בראשית</h1>" }, ...chapter(4, 1), ...chapter(25, 2)]);
const commentary = asBook(COMM, [{ text: "<h1>ביאור חדש על בראשית</h1>" }, { text: "<h2>פרק א</h2>" }, { text: "הסבר כללי על כל הפרק הראשון." }, { text: "<h2>פרק ב</h2>" }, { text: "הסבר כללי על כל הפרק השני." }]);

describe("withoutRange: which lines a span on a Sefaria side is written to", () => {
  const block = refBlockOf(base.lines);

  it("tells a heading and a line without a ref_2 apart, and accepts a verse", () => {
    expect([block(1), block(2), block(3)]).toEqual(["heading", "no-ref", null]);
    // a heRef whose prefix the library has no English title for gives no ref_2 either
    expect(refBlockByHeRef(() => "ספר שאינו בטבלה, א, א")(0)).toBe("no-ref");
  });

  it("a span of at most SPAN_EACH_LINE_MAX lines: a record for each line that can carry one, from the first of them", () => {
    const r = withoutRange({ book: BASE, line: 2, end: 6 }, block);
    expect(r.target).toEqual({ book: BASE, line: 3 });
    expect(r.citedSpan).toEqual({ line: 2, end: 6 });
    expect(r.lines).toEqual([3, 4, 5, 6]);
    expect(r.reason?.code).toBe("range/sefaria-each-line");
    expect(r.reason?.text).toContain("4 קישורים");
  });

  it("a longer span starting on a line without a heRef: ONE record, to its first line that has one (firstRef)", () => {
    const r = withoutRange({ book: BASE, line: 8, end: 33 }, block);
    expect(33 - 8 + 1).toBeGreaterThan(SPAN_EACH_LINE_MAX);
    expect(r.target).toEqual({ book: BASE, line: 9 });
    expect(r.lines).toBeUndefined();
    expect(r.citedSpan).toEqual({ line: 8, end: 33 });
    expect(r.reason).toEqual({ code: "range/sefaria-first-ref", text: expect.stringContaining("לשורה 9, שבה מתחיל הטווח, אין ציון ספריא") });
    expect(r.reason!.text).toContain("הקישור לשורה 10");
    // starting on a heading, the reason says it is a heading
    expect(firstRefIn(7, 33, block)).toEqual({ line: 9, reason: { code: "range/sefaria-first-ref", text: expect.stringContaining("היא כותרת") } });
  });

  it("a span where no line has a heRef: its first line, with no reason — as before (the export then holds or warns)", () => {
    const noRefs = refBlockOf(asBook(BASE, [{ text: "<h2>פרק א</h2>" }, { text: "שורה" }, { text: "שורה" }, { text: "שורה" }]).lines);
    expect(withoutRange({ book: BASE, line: 1, end: 3 }, noRefs)).toEqual({ target: { book: BASE, line: 1 }, citedSpan: { line: 1, end: 3 } });
    // nothing known about the lines (an engine called without them): the same
    expect(withoutRange({ book: BASE, line: 2, end: 6 })).toEqual({ target: { book: BASE, line: 2 }, citedSpan: { line: 2, end: 6 } });
    // and a single line is never touched
    expect(withoutRange({ book: BASE, line: 2 }, block)).toEqual({ target: { book: BASE, line: 2 } });
  });
});

describe("the engines write a cut span by that one rule", () => {
  it("headings on a Sefaria base: a short chapter a record per verse, a long one to its first verse; one suggestion each", () => {
    const r = runEngine("headings", commentary, base, { sefariaOwned: [BASE.key] });
    expect(r.suggestions.length).toBe(2);
    const [short, long] = r.suggestions;
    // פרק א: lines 2..6 (name + 4 verses) → the 4 verses, each with its own heRef
    expect(short!.target).toEqual({ book: BASE, line: 3 });
    expect(short!.citedSpan).toEqual({ line: 2, end: 6 });
    expect(recordsOf(short!).map((x) => x.line)).toEqual([3, 4, 5, 6]);
    expect(short!.spanLines!.map((x) => x.heRef2)).toEqual(["בראשית, א, א", "בראשית, א, ב", "בראשית, א, ג", "בראשית, א, ד"]);
    expect(short!.reasons.map((x) => x.code)).toContain("range/sefaria-each-line");
    expect(short!.reasons.map((x) => x.code)).not.toContain("heading/range-sefaria");
    expect(short!.rules).toContain("headings.each-line");
    // פרק ב: lines 8..33 → one record, to line 9 (not the name line 8)
    expect(long!.target).toEqual({ book: BASE, line: 9 });
    expect(long!.spanLines).toBeUndefined();
    expect(long!.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(["heading/range-sefaria", "range/sefaria-first-ref"]));
    expect(long!.rules).toContain("headings.first-ref");
    // still never "certain": the records are not the exact place (capSpanned)
    expect(short!.confidence).toBe("high");
    expect(short!.warnings.map((w) => w.code)).toContain("range/sefaria-not-exact");
    // the long chapter (26 lines) is wider than RANGE_WIDTH.highMax: "possible", and the width says why (#42 C15)
    expect(long!.confidence).toBe("possible");
    expect(long!.warnings.map((w) => w.code)).toContain("heading/wide-range");
  });

  it("a base the library does not treat as Sefaria's keeps its range, with no records and no reason", () => {
    const r = runEngine("headings", commentary, base, { sefariaOwned: [] });
    expect(r.suggestions.map((s) => s.target)).toEqual([
      { book: BASE, line: 2, end: 6 },
      { book: BASE, line: 8, end: 33 },
    ]);
    for (const s of r.suggestions) {
      expect(s.citedSpan).toBeUndefined();
      expect(s.spanLines).toBeUndefined();
      expect(s.reasons.map((x) => x.code)).not.toContain("range/sefaria-first-ref");
      expect(s.reasons.map((x) => x.code)).not.toContain("range/sefaria-each-line");
    }
  });

  it("dibur-hamatchil: a quote over a name line and a verse is written to the verse, with the line's own heRef", () => {
    // the ד"ה starts on the name line (no heRef) and runs into the first verse: a 2-line span, one writable line
    const b = asBook(BASE, [{ text: "<h1>בראשית</h1>" }, { text: "<h2>פרק א</h2>" }, { text: "דיני תפילת השחר" }, { text: "ובו שמונה סעיפים קטנים מאד", heRef: "בראשית, א, א" }, { text: "ויאמר אלהים יהי אור", heRef: "בראשית, א, ב" }]);
    const c = asBook(COMM, [{ text: "<h1>ביאור חדש על בראשית</h1>" }, { text: "<h2>פרק א</h2>" }, { text: "<b>דיני תפילת השחר ובו שמונה</b> - הסבר." }]);
    const r = runEngine("dibur-hamatchil", c, b, { sefariaOwned: [BASE.key] });
    const s = r.suggestions.find((x) => x.citedSpan);
    expect(s?.citedSpan).toEqual({ line: 2, end: 3 });
    expect(s!.target).toEqual({ book: BASE, line: 3 });
    expect(s!.spanLines).toBeUndefined();
    expect(s!.heRef2).toBe("בראשית, א, א");
    expect(s!.reasons.map((x) => x.code)).toEqual(expect.arrayContaining(["dh/range-sefaria", "range/sefaria-first-ref"]));
  });
});
