import { describe, expect, it } from "vitest";
import type { BookRef, LinkSide } from "../../../src/core/links/model";
import type { Confidence, EngineId, Suggestion } from "../../../src/linking/automatic";
import { linePairKey, mergeSuggestions, type MergeItem } from "../../../src/linking/merge";
import { competingTargets, type PlanStep } from "../../../src/linking/plan";

/*
 * Fix round before the merge of PR 2.
 * Claim 10: the library's link is COARSE (many commentary lines to one base line: a whole siman, a whole chapter) and the engines find the
 *   exact line inside it. That is not a contradiction of an exact link: the exact suggestion must not be lowered by maxlink/contradicts-library.
 * Claim 7/8: competing candidate books of one commentary (competingTargets) are never all certain.
 */
const C: BookRef = { key: "t:1", title: "ביאור על בראשית", origin: "otzaria" };
const B: BookRef = { key: "d:1", title: "בראשית", origin: "otzaria" };
const side = (book: BookRef, line: number, end?: number): LinkSide => ({ book, line, ...(end !== undefined && { end }) });
const SCORE: Record<Confidence, number> = { certain: 1, high: 0.9, possible: 0.7, ambiguous: 0.8, none: 0.3 };
function sg(engine: EngineId, source: LinkSide, target: LinkSide, confidence: Confidence, more: Partial<Suggestion> = {}): Suggestion {
  const id = `${engine}:${source.book.key}#${source.line}${more.anchor ? `@${more.anchor.rawStart}` : ""}>${target.book.key}#${target.line}-${target.end ?? ""}`;
  return { id, engine, source, target, declaredType: "source", heRef2: "", score: SCORE[confidence], confidence, reasons: [{ code: `${engine}/r`, text: "x" }], rules: [`${engine}/rule`], alternatives: [], warnings: [], ...more };
}
const H = (c: number, b: number, conf: Confidence, end?: number): MergeItem => ({ suggestion: sg("headings", side(C, c), side(B, b, end), conf), focus: C.key });
const D = (c: number, b: number, conf: Confidence): MergeItem => ({ suggestion: sg("dibur-hamatchil", side(B, b), side(C, c), conf, { declaredType: "commentary", anchor: { rawStart: 3, rawEnd: 9 } }), focus: C.key });

describe("mergeSuggestions — a coarse library link does not contradict an exact suggestion inside it", () => {
  // the library links commentary lines 0-9 to base line 0, 10-19 to base line 50, 20-29 to base line 100: three whole sections
  const coarse = Array.from({ length: 30 }, (_, i) => linePairKey({ source: side(C, i), target: side(B, Math.floor(i / 10) * 50) }));
  // the engines find the exact line INSIDE each section (the next library target, 50 lines on, bounds the section)
  const inside = Array.from({ length: 30 }, (_, i) => [H(i, Math.floor(i / 10) * 50 + 1 + (i % 10), "certain"), D(i, Math.floor(i / 10) * 50 + 1 + (i % 10), "certain")]).flat();

  it("nothing is lowered, no pair is called contradicted", () => {
    const { suggestions, stats } = mergeSuggestions(inside, { reference: coarse });
    expect(stats.contradictedPairs).toBe(0);
    expect(suggestions.every((s) => s.confidence === "certain")).toBe(true);
    expect(suggestions.some((s) => s.rules.includes("maxlink/contradicts-library"))).toBe(false);
  });

  it("an exact suggestion OUTSIDE every section the library names is still a contradiction", () => {
    // the sections run 0-49, 50-99, 100-(last+gap): the suggestions below sit far beyond the last section
    const outside = Array.from({ length: 30 }, (_, i) => [H(i, 400 + i, "certain"), D(i, 400 + i, "certain")]).flat();
    const { stats } = mergeSuggestions(outside, { reference: coarse });
    expect(stats.contradictedPairs).toBe(1);
  });

  it("exact library links (one line each) with a different line are still a contradiction, as before", () => {
    const exact = Array.from({ length: 30 }, (_, i) => linePairKey({ source: side(C, i), target: side(B, i + 100) }));
    const ours = Array.from({ length: 30 }, (_, i) => [H(i, i, "certain", i + 1), D(i, i, "certain")]).flat();
    expect(mergeSuggestions(ours, { reference: exact }).stats.contradictedPairs).toBe(1);
  });

  it("a place shared by only two commentary lines is not 'coarse': it does not excuse a different line", () => {
    const few = [0, 1].map((i) => linePairKey({ source: side(C, i), target: side(B, 10) }));
    const many = Array.from({ length: 28 }, (_, i) => linePairKey({ source: side(C, i + 2), target: side(B, 200 + i * 5) }));
    const ours = Array.from({ length: 30 }, (_, i) => [H(i, i, "certain"), D(i, i, "certain")]).flat();
    expect(mergeSuggestions(ours, { reference: [...few, ...many] }).stats.contradictedPairs).toBe(1);
  });
});

describe("competingTargets — books a commentary is aimed at in several ways (fix round, claim 7)", () => {
  const ref = (key: string): BookRef => ({ key, title: key, origin: "otzaria" });
  const pair = (engine: "headings" | "dibur-hamatchil" | "footnotes", source: string, target: string, more: Partial<Extract<PlanStep, { kind: "pair" }>> = {}, relation: Record<string, unknown> = {}): PlanStep =>
    ({ id: `${engine}|${source}>${target}`, kind: "pair", engine, source: ref(source), target: ref(target), why: "", relation: { kind: "commentary", dependant: ref(source), base: ref(target), via: "title", caveats: [], ...relation }, ...more }) as PlanStep;

  it("a source with two different plain targets: both are candidates (once each)", () => {
    expect(competingTargets([pair("headings", "c", "a"), pair("dibur-hamatchil", "c", "a"), pair("dibur-hamatchil", "c", "b")]).sort()).toEqual(["a", "b"]);
  });

  it("one target, a part of the book (scope), a path through another commentary, a footnotes step or an addressed-only step: no competition", () => {
    expect(competingTargets([pair("headings", "c", "a"), pair("dibur-hamatchil", "c", "a")])).toEqual([]);
    expect(competingTargets([pair("dibur-hamatchil", "c", "a"), pair("dibur-hamatchil", "c", "b", {}, { scope: { section: "b" } })])).toEqual([]);
    expect(competingTargets([pair("dibur-hamatchil", "c", "a"), pair("dibur-hamatchil", "c", "b", {}, { through: [] })])).toEqual([]);
    expect(competingTargets([pair("dibur-hamatchil", "c", "a"), pair("footnotes", "c", "b")])).toEqual([]);
    expect(competingTargets([pair("dibur-hamatchil", "c", "a"), pair("dibur-hamatchil", "c", "b", { options: { addressedOnly: true } })])).toEqual([]);
  });

  it("different sources do not compete with each other", () => {
    expect(competingTargets([pair("dibur-hamatchil", "c1", "a"), pair("dibur-hamatchil", "c2", "b")])).toEqual([]);
  });

  it("with the targets as candidates, a line certain in both is ambiguous, and the more certain wins one step down", () => {
    const B2: BookRef = { key: "d:2", title: "ספר שני", origin: "otzaria" };
    const toB2 = (c: number, b: number, conf: Confidence): MergeItem => ({ suggestion: sg("dibur-hamatchil", side(C, c), side(B2, b), conf), focus: C.key });
    const both = mergeSuggestions([H(5, 10, "certain"), toB2(5, 3, "certain")], { candidateBooks: [B.key, B2.key] });
    expect(both.suggestions.map((s) => s.confidence)).toEqual(["ambiguous", "ambiguous"]);
    const won = mergeSuggestions([H(5, 10, "certain"), toB2(5, 3, "high")], { candidateBooks: [B.key, B2.key] });
    expect(won.suggestions.map((s) => s.confidence)).toEqual(["high"]);
  });
});
