import { describe, expect, it } from "vitest";
import type { BookRef, LinkSide } from "../../../src/core/links/model";
import type { Confidence, EngineId, Suggestion } from "../../../src/linking/automatic";
import { CONTAINMENT_MAX_WIDTH, mergeSuggestions, type MergeItem } from "../../../src/linking/merge";

/*
 * #41 B1: containment is evidence only when it is INDEPENDENT. The ד"ה engine searches inside the section the commentary's
 * own headings name (dh/window-heading, -unit, -page, -caller) — the very headings the headings engine reads — so a ד"ה line
 * inside the headings range is inside it by construction. Measured on the official database (משנה ברורה ← שולחן ערוך אורח
 * חיים): 924 "possible" ד"ה lines were raised to "high" that way, 846 of them contradicting the database, and each one
 * replaced the (right) siman range it was folded into.
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
/** a ד"ה line found in the given search window (the engine's own rule, dh/window-<kind>) */
const D = (c: number, b: number, conf: Confidence, window: "heading" | "unit" | "page" | "caller" | "book"): MergeItem => ({
  suggestion: sg("dibur-hamatchil", side(B, b), side(C, c), conf, { declaredType: "commentary", anchor: { rawStart: 3, rawEnd: 9 }, rules: ["dh/extract-bold", `dh/window-${window}`] }),
  focus: C.key,
});

describe("merge — containment that the headings themselves produced is not evidence (#41 B1)", () => {
  it("a weak ד\"ה line found inside the headings' own section is not raised by that section; the range is kept as its alternative", () => {
    const { suggestions, stats } = mergeSuggestions([H(5, 10, "high", 20), D(5, 15, "possible", "heading")]);
    expect(suggestions).toHaveLength(1);
    const s = suggestions[0]!;
    expect(s).toMatchObject({ engine: "dibur-hamatchil", confidence: "possible" });
    expect(s.source).toEqual(side(B, 15));
    expect(s.rules).toContain("maxlink/contains-dependent");
    expect(s.rules).not.toContain("maxlink/raised");
    // the coarse range is not lost: it is the first alternative, with the reason
    expect(s.alternatives.map((a) => a.target)).toContainEqual(side(B, 10, 20));
    expect(s.alternatives.find((a) => a.target.line === 10)!.reasons[0]!.code).toBe("maxlink/coarse");
    expect(s.members).toHaveLength(2);
    expect(stats.raised).toBe(0);
  });

  it("the same for every window drawn from the commentary's headings (unit, page, caller), and for a line whose window is not known", () => {
    for (const w of ["unit", "page", "caller"] as const) {
      const s = mergeSuggestions([H(5, 10, "certain", 20), D(5, 15, "possible", w)]).suggestions[0]!;
      expect(s, w).toMatchObject({ engine: "dibur-hamatchil", confidence: "possible" });
      expect(s.rules, w).toContain("maxlink/contains-dependent");
    }
    const inherited: MergeItem = { suggestion: sg("dibur-hamatchil", side(B, 15), side(C, 5), "possible", { declaredType: "commentary", anchor: { rawStart: 3, rawEnd: 9 }, rules: ["dh/inherit"] }), focus: C.key };
    expect(mergeSuggestions([H(5, 10, "certain", 20), inherited]).suggestions[0]!.confidence).toBe("possible");
  });

  it("a dependent ד\"ה line as sure as the range is the representative, but is not raised; the range is kept as its alternative", () => {
    const s = mergeSuggestions([H(5, 10, "high", 20), D(5, 15, "high", "heading")]).suggestions[0]!;
    expect(s).toMatchObject({ engine: "dibur-hamatchil", confidence: "high" });
    expect(s.source).toEqual(side(B, 15)); // the anchored record: base → commentary
    expect(s.alternatives.map((a) => a.target)).toContainEqual(side(B, 10, 20));
    expect(s.rules).not.toContain("maxlink/raised");
    expect(s.reasons.some((r) => r.code === "maxlink/contains-dependent")).toBe(true);
  });

  it("a ד\"ה found by searching the WHOLE base and landing in a narrow range is independent: raised to high, never to certain", () => {
    const s = mergeSuggestions([H(5, 10, "certain", 20), D(5, 15, "possible", "book")]).suggestions[0]!;
    expect(s).toMatchObject({ engine: "dibur-hamatchil", confidence: "high" });
    expect(s.rules).toEqual(expect.arrayContaining(["maxlink/consistent", "maxlink/raised"]));
    expect(s.reasons.find((r) => r.code === "maxlink/consistent")!.text).toContain("בכל ספר הבסיס");
    expect(s.alternatives.map((a) => a.target)).toContainEqual(side(B, 10, 20));
    expect(mergeSuggestions([H(5, 10, "certain", 20), D(5, 15, "high", "book")]).suggestions[0]!.confidence).toBe("high");
  });

  it("weighted by width: a range wider than CONTAINMENT_MAX_WIDTH confirms nothing, even for an independent search", () => {
    const wide = mergeSuggestions([H(5, 10, "certain", 10 + CONTAINMENT_MAX_WIDTH), D(5, 15, "possible", "book")]).suggestions[0]!;
    expect(wide.confidence).toBe("possible");
    expect(wide.rules).toContain("maxlink/contains-wide");
    expect(wide.rules).not.toContain("maxlink/raised");
    const narrow = mergeSuggestions([H(5, 10, "certain", 10 + CONTAINMENT_MAX_WIDTH - 1), D(5, 15, "possible", "book")]).suggestions[0]!;
    expect(narrow.confidence).toBe("high");
  });

  it("an exact agreement where the ד\"ה searched only the line the heading names (window-unit) is one piece of evidence: no step up", () => {
    const dep = mergeSuggestions([H(5, 15, "high"), D(5, 15, "high", "unit")]).suggestions[0]!;
    expect(dep.engines).toEqual(["headings", "dibur-hamatchil"]);
    expect(dep.confidence).toBe("high");
    expect(dep.rules).toContain("maxlink/agree-dependent");
    // a ד"ה found in the whole section, on the very line the heading names: two kinds of evidence, one step up
    expect(mergeSuggestions([H(5, 15, "high"), D(5, 15, "high", "heading")]).suggestions[0]!.confidence).toBe("certain");
  });

  it("records the provenance of every piece of evidence, and whether it was counted", () => {
    const s = mergeSuggestions([H(5, 10, "high", 20), D(5, 15, "possible", "heading")]).suggestions[0]!;
    expect(s.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ engine: "dibur-hamatchil", role: "representative", basis: "words-in-heading-window", width: 1, counted: true }),
        expect.objectContaining({ engine: "headings", role: "containing", basis: "structure", width: 11, counted: false }),
      ]),
    );
    const t = mergeSuggestions([H(5, 10, "high", 20), D(5, 15, "possible", "book")]).suggestions[0]!;
    expect(t.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ engine: "dibur-hamatchil", role: "representative", basis: "words-whole-book", counted: true }),
        expect.objectContaining({ engine: "headings", role: "containing", basis: "structure", width: 11, counted: true }),
      ]),
    );
  });

  it("stays a function of the raw suggestions: re-merging decides the same", () => {
    const items = [H(5, 10, "high", 20), D(5, 15, "possible", "heading"), H(6, 10, "high", 20), D(6, 16, "possible", "book"), H(7, 30, "high", 200), D(7, 40, "possible", "book")];
    const once = mergeSuggestions(items);
    expect(mergeSuggestions(once.suggestions).suggestions).toEqual(once.suggestions);
    expect(mergeSuggestions([...items].reverse()).suggestions).toEqual(once.suggestions);
  });
});
