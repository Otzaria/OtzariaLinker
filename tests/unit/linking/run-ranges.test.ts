import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { headingLevel } from "../../../src/core/text/html";
import { runEngine, type EngineBook, type Suggestion } from "../../../src/linking/automatic";
import { sanitizeStoredOptions, toEngineOptions } from "../../../src/linking/automatic/option-specs";
import { bookFingerprint, parseJobRecord } from "../../../src/linking/batch-job";
import type { PlanStep } from "../../../src/linking/plan";
import { applyRunRanges } from "../../../src/linking/ranges";

/*
 * v3 F-104 (`runMatches`, link kinds rangeSource / rangeTarget / rangeBoth): an automatic run could give every link a range "until the next
 * match" on the source, on the target, or on both. In V7 the engines' own ranges (a heading's section) were the only ones; a source range
 * came only from "range completion" afterwards. The run's range options (linking/ranges.ts applyRunRanges) restore it for every pair engine,
 * travel with the engine's options, and so are stored with a job and change its fingerprint. Synthetic neutral words; no book text.
 */
const book = (key: string, title: string, lines: readonly string[], origin: BookRef["origin"] = "otzaria"): EngineBook => ({
  book: { key, title, origin },
  lines: lines.map((text, index) => ({ index, text, heading: headingLevel(text) })),
});

const BASE = book("b", "בראשית", ["<h1>בראשית</h1>", "<h2>פרק א</h2>", "(א) אלפא בטא", "(ב) גמא דלתא", "(ג) הא וו", "<h2>פרק ב</h2>", "(א) זין חית", "(ב) טית יוד"]);
const COMM = book("c", "ביאור על בראשית", [
  "<h1>ביאור על בראשית</h1>", // 0
  "<h2>פרק א</h2>", //          1
  "<h3>פסוק א</h3>", //         2
  "אלפא. פירוש ראשון", //       3
  "המשך הפירוש", //             4
  "<h3>פסוק ג</h3>", //         5
  "הא. פירוש שני", //           6
  "<h2>פרק ב</h2>", //          7
  "<h3>פסוק ב</h3>", //         8
  "טית. פירוש שלישי", //        9
  "עוד דברים", //               10
]);
const srcOf = (r: { suggestions: readonly Suggestion[] }) => r.suggestions.map((s) => [s.source.line, s.source.end ?? null]);

describe("the run's ranges: until the next match (v3 F-104)", () => {
  it("source 'next-match': every source line ranges to the line before the next suggestion's line or the next heading", () => {
    const plain = runEngine("headings", COMM, BASE);
    expect(srcOf(plain)).toEqual([[3, null], [4, null], [6, null], [9, null], [10, null]]);
    const r = runEngine("headings", COMM, BASE, { sourceRange: "next-match" });
    // 3 and 4 both have a suggestion (no range); 6 stops before the heading at 7; 9 before 10, which has its own suggestion; 10 is the end of the book
    expect(srcOf(r)).toEqual([[3, null], [4, null], [6, null], [9, null], [10, null]]);
    // the targets are untouched
    expect(r.suggestions.map((s) => s.target)).toEqual(plain.suggestions.map((s) => s.target));
  });

  it("the next MATCH, not the next line: lines the engine did not link fall inside the range of the line before them", () => {
    // without the continuation lines the engine skips (fewer than two Hebrew letters), the ranges are visible
    const sparse = book("c2", "ביאור על בראשית", ["<h2>פרק א</h2>", "<h3>פסוק א</h3>", "אלפא. פירוש", "1", "2", "<h3>פסוק ג</h3>", "הא. פירוש", "3"]);
    const r = runEngine("headings", sparse, BASE, { sourceRange: "next-match" });
    expect(srcOf(r)).toEqual([[2, 4], [6, 7]]);
    expect(r.suggestions[0]!.reasons.some((x) => x.code === "range/source-next-match")).toBe(true);
    expect(r.suggestions[0]!.rules).toContain("ranges.source-next-match");
    expect(r.notes.some((n) => n.code === "range/run-ranges")).toBe(true);
  });

  it("target 'line' drops the engine's section range; target 'next-match' ranges to the next suggestion's target line", () => {
    const chapter = book("c3", "ביאור על בראשית", ["<h2>פרק א</h2>", "פירוש על כל הפרק", "<h2>פרק ב</h2>", "פירוש על הפרק השני"]);
    const engine = runEngine("headings", chapter, BASE);
    expect(engine.suggestions.map((s) => [s.target.line, s.target.end ?? null])).toEqual([[2, 4], [6, 7]]);
    const line = runEngine("headings", chapter, BASE, { targetRange: "line" });
    expect(line.suggestions.map((s) => [s.target.line, s.target.end ?? null])).toEqual([[2, null], [6, null]]);
    const verses = book("c4", "ביאור על בראשית", ["<h2>פרק א</h2>", "<h3>פסוק א</h3>", "אלפא. פירוש", "<h3>פסוק ג</h3>", "הא. פירוש"]);
    const next = runEngine("headings", verses, BASE, { targetRange: "next-match" });
    // (א) at 2 runs to 3 (the line before (ג), the next target); (ג) at 4 stops before the heading at 5
    expect(next.suggestions.map((s) => [s.target.line, s.target.end ?? null])).toEqual([[2, 3], [4, null]]);
  });

  it("the sides are the run's books, not the record's direction (dibur-hamatchil may write base → commentary)", () => {
    const sug = (src: { book: BookRef; line: number }, tgt: { book: BookRef; line: number }): Suggestion =>
      ({ id: `${src.line}`, engine: "dibur-hamatchil", source: src, target: tgt, declaredType: "commentary", heRef2: "", score: 1, confidence: "certain", reasons: [], rules: [], alternatives: [], warnings: [] }) as Suggestion;
    // records written base → commentary: the commentary (the run's source) is the record's TARGET
    const list = [sug({ book: BASE.book, line: 2 }, { book: COMM.book, line: 3 }), sug({ book: BASE.book, line: 4 }, { book: COMM.book, line: 9 })];
    const books = { source: { key: "c", lineCount: 11, headings: new Set([0, 1, 2, 5, 7, 8]) }, target: { key: "b", lineCount: 8, headings: new Set([0, 1, 5]) } };
    const out = applyRunRanges(list, books, { sourceRange: "next-match" }).suggestions;
    expect(out.map((s) => [s.target.line, s.target.end ?? null])).toEqual([[3, 4], [9, 10]]);
    expect(out.map((s) => s.source.end)).toEqual([undefined, undefined]);
  });

  it("no range on a Sefaria book (the weekly sync remaps only the start), with a note", () => {
    const sparse = book("c5", "ביאור על בראשית", ["<h2>פרק א</h2>", "<h3>פסוק א</h3>", "אלפא. פירוש", "1", "2"], "sefaria");
    const r = runEngine("headings", sparse, BASE, { sourceRange: "next-match" });
    expect(srcOf(r)).toEqual([[2, null]]);
    expect(r.notes.some((n) => n.code === "range/run-ranges-sefaria")).toBe(true);
  });

  it("a value no form can make is an error with a code, never ignored", () => {
    expect(() => runEngine("headings", COMM, BASE, { sourceRange: "everything" })).toThrow(expect.objectContaining({ code: "engine/invalid-option" }));
  });

  it("the default ('engine' on both sides) changes nothing: the same result as no option at all", () => {
    expect(runEngine("headings", COMM, BASE, { sourceRange: "engine", targetRange: "engine" })).toEqual(runEngine("headings", COMM, BASE));
  });
});

describe("the run's ranges are options of every pair engine: the form, storage and the job's fingerprint", () => {
  for (const engine of ["headings", "dibur-hamatchil", "footnotes", "pattern"] as const) {
    it(`${engine}: the form passes them, storage keeps only valid ones`, () => {
      const r = toEngineOptions(engine, { sourceRange: "next-match", targetRange: "line" });
      expect(r.errors).toEqual({});
      expect(r.options).toMatchObject({ sourceRange: "next-match", targetRange: "line" });
      // the default is not sent: a run with untouched settings is byte-identical
      expect(toEngineOptions(engine, { sourceRange: "engine", targetRange: "engine" }).options).toEqual({});
      expect(toEngineOptions(engine, { sourceRange: "all" }).errors["sourceRange"]).toBeTruthy();
      expect(sanitizeStoredOptions(engine, { sourceRange: "next-match", targetRange: "nope" })).toEqual({ sourceRange: "next-match" });
    });
  }

  it("a job keeps them, and another range option is another fingerprint (a book is not reused as 'unchanged')", () => {
    const C = { key: "s1:c", title: "ביאור על בראשית", origin: "otzaria" } as const;
    const B = { key: "s1:b", title: "בראשית", origin: "otzaria" } as const;
    const steps = [{ id: "h", kind: "pair", engine: "headings", source: C, target: B, relation: {}, why: "" } as unknown as PlanStep];
    const fps = { [C.key]: "c1", [B.key]: "b1" };
    const none = bookFingerprint(steps, fps);
    const next = bookFingerprint(steps, fps, { headings: { sourceRange: "next-match" } });
    expect(next).not.toBe(none);
    expect(bookFingerprint(steps, fps, { headings: { sourceRange: "line" } })).not.toBe(next);
    const stored = JSON.stringify({ v: 1, id: "x", scope: "s", sources: ["a"], state: "paused", books: [], startedAt: 1, ms: 1, engineOptions: { headings: { sourceRange: "next-match", targetRange: "bogus" } } });
    expect(parseJobRecord(stored)!.engineOptions).toEqual({ headings: { sourceRange: "next-match" } });
  });
});
