import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BookRef, LinkSide } from "../../../src/core/links/model";
import type { Confidence, EngineId, Suggestion } from "../../../src/linking/automatic";
import { linePairKey, mergeItems, mergeSuggestions, type MergeItem } from "../../../src/linking/merge";

const C: BookRef = { key: "t:1", title: "ביאור על בראשית", origin: "otzaria" };
const B: BookRef = { key: "d:1", title: "בראשית", origin: "otzaria" };
const M: BookRef = { key: "t:2", title: "ספר דוגמה", origin: "otzaria" };
const N: BookRef = { key: "t:3", title: "הערות לספר דוגמה", origin: "otzaria" };
const side = (book: BookRef, line: number, end?: number): LinkSide => ({ book, line, ...(end !== undefined && { end }) });
const SCORE: Record<Confidence, number> = { certain: 1, high: 0.9, possible: 0.7, ambiguous: 0.8, none: 0.3 };

function sg(engine: EngineId, source: LinkSide, target: LinkSide, confidence: Confidence, more: Partial<Suggestion> = {}): Suggestion {
  const id = `${engine}:${source.book.key}#${source.line}${more.anchor ? `@${more.anchor.rawStart}` : ""}>${target.book.key}#${target.line}-${target.end ?? ""}`;
  return { id, engine, source, target, declaredType: "source", heRef2: "", score: SCORE[confidence], confidence, reasons: [{ code: `${engine}/r`, text: "x" }], rules: [`${engine}/rule`], alternatives: [], warnings: [], ...more };
}
/** headings: commentary line → base line(s) */
const H = (c: number, b: number, conf: Confidence, end?: number): MergeItem => ({ suggestion: sg("headings", side(C, c), side(B, b, end), conf), focus: C.key });
/** dibur-hamatchil, form B: base line (anchored) → commentary line */
const D = (c: number, b: number, conf: Confidence): MergeItem => ({ suggestion: sg("dibur-hamatchil", side(B, b), side(C, c), conf, { declaredType: "commentary", anchor: { rawStart: 3, rawEnd: 9 } }), focus: C.key });
/** footnotes: main line @marker → note line */
const F = (m: number, at: number, n: number, conf: Confidence): MergeItem => ({ suggestion: sg("footnotes", side(M, m), side(N, n), conf, { anchor: { rawStart: at, rawEnd: at + 1 } }), focus: M.key });

describe("mergeSuggestions — the same link from several engines", () => {
  it("headings (commentary → base) and dibur-hamatchil (base → commentary, anchored) are ONE link", () => {
    const { suggestions, stats } = mergeSuggestions([H(5, 10, "high"), D(5, 10, "high")]);
    expect(suggestions).toHaveLength(1);
    const s = suggestions[0]!;
    expect(s.engines).toEqual(["headings", "dibur-hamatchil"]);
    expect(s.engine).toBe("dibur-hamatchil"); // the anchored record represents it
    expect(s.anchor?.rawStart).toBe(3);
    expect(s.confidence).toBe("certain"); // two independent engines, each "high": one step up
    expect(s.rules).toEqual(expect.arrayContaining(["maxlink/agree", "maxlink/engine:headings", "maxlink/engine:dibur-hamatchil", "maxlink/raised"]));
    expect(s.reasons.some((r) => r.code === "maxlink/agree")).toBe(true);
    expect(stats).toMatchObject({ input: 2, output: 1, duplicates: 1, agreements: 1, raised: 1, conflicts: 0 });
  });

  it("raises one step at most, and never on ambiguous support", () => {
    expect(mergeSuggestions([H(5, 10, "possible"), D(5, 10, "possible")]).suggestions[0]!.confidence).toBe("high");
    expect(mergeSuggestions([H(5, 10, "high"), D(5, 10, "ambiguous")]).suggestions[0]!.confidence).toBe("high");
    expect(mergeSuggestions([H(5, 10, "ambiguous"), D(5, 10, "ambiguous")]).suggestions[0]!.confidence).toBe("ambiguous");
  });

  it("a single engine's suggestion passes through with its own confidence", () => {
    const { suggestions } = mergeSuggestions([H(5, 10, "possible")]);
    expect(suggestions[0]!.confidence).toBe("possible");
    expect(suggestions[0]!.engines).toEqual(["headings"]);
    expect(suggestions[0]!.rules).not.toContain("maxlink/agree");
  });

  it("ids depend on the two lines only: the same link keeps its id when another engine joins or leaves", () => {
    const both = mergeSuggestions([H(5, 10, "high"), D(5, 10, "high")]).suggestions[0]!.id;
    expect(mergeSuggestions([H(5, 10, "high")]).suggestions[0]!.id).toBe(both);
    expect(mergeSuggestions([D(5, 10, "possible")]).suggestions[0]!.id).toBe(both);
  });

  it("two markers on one line pointing at the same note stay two links (one engine, two anchors)", () => {
    const { suggestions } = mergeSuggestions([F(2, 4, 7, "certain"), F(2, 30, 7, "certain")]);
    expect(suggestions.map((s) => s.anchor?.rawStart)).toEqual([4, 30]);
    expect(new Set(suggestions.map((s) => s.id)).size).toBe(2);
  });
});

describe("mergeSuggestions — conflicts and coarser agreement", () => {
  it("different targets for the same commentary line that the evidence does not settle → ambiguous, each with the other as alternative", () => {
    // two certain sides: nothing tells them apart
    const { suggestions, stats } = mergeSuggestions([H(5, 10, "certain"), D(5, 14, "certain")]);
    expect(suggestions).toHaveLength(2);
    for (const s of suggestions) {
      expect(s.confidence).toBe("ambiguous");
      expect(s.rules).toContain("maxlink/conflict");
      expect(s.warnings.some((w) => w.code === "maxlink/conflict")).toBe(true);
    }
    const h = suggestions.find((s) => s.engine === "headings")!;
    expect(h.alternatives[0]!.target).toEqual(side(B, 14));
    expect(stats).toMatchObject({ conflicts: 2, settled: 0, outweighed: 0 });
  });

  it("different lines of the commentary are not a conflict", () => {
    const { suggestions } = mergeSuggestions([H(5, 10, "certain"), D(6, 14, "high")]);
    expect(suggestions.map((s) => s.confidence)).toEqual(["certain", "high"]);
  });

  it("a range that contains the other engine's line is folded into the precise one, which may rise to high — not to certain", () => {
    const { suggestions, stats } = mergeSuggestions([H(5, 10, "high", 20), D(5, 15, "possible")]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.engine).toBe("dibur-hamatchil");
    expect(suggestions[0]!.confidence).toBe("high");
    expect(suggestions[0]!.rules).toContain("maxlink/consistent");
    expect(suggestions[0]!.members).toHaveLength(2);
    expect(stats).toMatchObject({ consistent: 1, duplicates: 1, conflicts: 0 });
    expect(mergeSuggestions([H(5, 10, "high", 20), D(5, 15, "high")]).suggestions[0]!.confidence).toBe("high");
  });

  it("an ambiguous line inside a supported range does not replace it: the range stays, the line is its alternative", () => {
    const { suggestions } = mergeSuggestions([H(5, 10, "certain", 20), D(5, 15, "ambiguous")]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!).toMatchObject({ engine: "headings", confidence: "certain" });
    expect(suggestions[0]!.rules).toContain("maxlink/inner");
    expect(suggestions[0]!.alternatives[0]!.target).toEqual(side(B, 15));
    expect(suggestions[0]!.members).toHaveLength(2);
  });
});

describe("mergeSuggestions — a conflict the evidence settles", () => {
  it("the only certain side wins, one step down; the other is folded into it as an alternative, with the reason", () => {
    const { suggestions, stats } = mergeSuggestions([H(5, 10, "certain"), D(5, 14, "high")]);
    expect(suggestions).toHaveLength(1);
    const s = suggestions[0]!;
    expect(s).toMatchObject({ engine: "headings", confidence: "high" });
    expect(s.rules).toContain("maxlink/outweighs");
    expect(s.rules).not.toContain("maxlink/conflict");
    expect(s.warnings.map((w) => w.code)).toContain("maxlink/outweighs");
    expect(s.alternatives[0]).toMatchObject({ target: side(B, 14) });
    expect(s.alternatives[0]!.reasons[0]!.code).toBe("maxlink/outweighed");
    // the loser is not dropped: it stays among the members, and a re-merge decides the same
    expect(s.members.map((m) => m.suggestion.engine).sort()).toEqual(["dibur-hamatchil", "headings"]);
    expect(stats).toMatchObject({ input: 2, output: 1, conflicts: 0, settled: 1, outweighed: 1 });
  });

  it("without a certain side, the quote (dibur-hamatchil) outweighs the headings at any level — and is never raised by winning", () => {
    const win = (h: Confidence, d: Confidence) => mergeSuggestions([H(5, 10, h), D(5, 14, d)]).suggestions;
    for (const [h, d, out] of [
      ["high", "high", "possible"],
      ["ambiguous", "high", "possible"],
      ["high", "possible", "possible"],
      ["high", "ambiguous", "ambiguous"],
      ["ambiguous", "ambiguous", "ambiguous"],
    ] as const) {
      const list = win(h, d);
      expect(list).toHaveLength(1);
      expect(list[0]!).toMatchObject({ engine: "dibur-hamatchil", confidence: out });
      expect(list[0]!.alternatives.map((a) => a.target)).toContainEqual(side(B, 10));
    }
    // the quote is certain, the heading not: certain → high
    expect(win("high", "certain")[0]!).toMatchObject({ engine: "dibur-hamatchil", confidence: "high" });
  });

  it("in a book pair whose structure is in doubt, a certain heading does not win by its certainty: the quote does", () => {
    // as in "a book pair whose engines mostly disagree": the Rif's own dapim read as the Talmud's
    const pair = Array.from({ length: 12 }, (_, i) => [H(i, i, "certain"), D(i, i + 40, "high")]).flat();
    const { suggestions, stats } = mergeSuggestions(pair);
    expect(stats.suspectPairs).toBe(1);
    expect(suggestions).toHaveLength(12);
    for (const s of suggestions) expect(s).toMatchObject({ engine: "dibur-hamatchil", confidence: "possible" });
  });

  it("is a function of the raw suggestions: merging the merged list again settles the same way", () => {
    const once = mergeSuggestions([H(5, 10, "high"), D(5, 14, "possible"), H(6, 11, "certain"), D(6, 20, "high")]);
    expect(mergeSuggestions(once.suggestions).suggestions).toEqual(once.suggestions);
    expect(mergeSuggestions([D(6, 20, "high"), H(5, 10, "high"), D(5, 14, "possible"), H(6, 11, "certain")]).suggestions).toEqual(once.suggestions);
  });
});

describe("mergeSuggestions — a range collapsed on a Sefaria side keeps its span (citedSpan)", () => {
  // headings on a Sefaria base: the section's first line is written, the section stays in citedSpan
  const Hs = (c: number, b: number, end: number, conf: Confidence): MergeItem => ({ suggestion: sg("headings", side(C, c), side(B, b), conf, { citedSpan: { line: b, end } }), focus: C.key });
  /** dibur-hamatchil without an anchor (a Sefaria base): commentary line → base line */
  const Dc = (c: number, b: number, conf: Confidence, citedSpan?: { line: number; end: number }): MergeItem => ({ suggestion: sg("dibur-hamatchil", side(C, c), side(B, b), conf, { declaredType: "commentary", ...(citedSpan && { citedSpan }) }), focus: C.key });

  it("a ד\"ה line inside the collapsed section agrees with it, as it did with the range: folded, not a conflict", () => {
    const { suggestions, stats } = mergeSuggestions([Hs(5, 10, 20, "high"), Dc(5, 15, "possible")]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!).toMatchObject({ engine: "dibur-hamatchil", confidence: "high" });
    expect(suggestions[0]!.target).toEqual(side(B, 15));
    expect(suggestions[0]!.rules).toContain("maxlink/consistent");
    expect(stats).toMatchObject({ consistent: 1, conflicts: 0 });
    // the bug it fixes: without the span the section's first line and the ד"ה line conflicted, both ambiguous
    // (now settled for the quote, settle in merge.ts — but a conflict all the same, not an agreement)
    const bare = mergeSuggestions([{ suggestion: sg("headings", side(C, 5), side(B, 10), "high"), focus: C.key }, Dc(5, 15, "possible")]);
    expect(bare.stats).toMatchObject({ consistent: 0, settled: 1, outweighed: 1 });
  });

  it("a ד\"ה on the section's first line is inside it, not the same link: consistent (at most high), never raised to certain", () => {
    const { suggestions, stats } = mergeSuggestions([Hs(5, 10, 20, "high"), Dc(5, 10, "high")]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!).toMatchObject({ engine: "dibur-hamatchil", confidence: "high" });
    expect(stats).toMatchObject({ agreements: 0, consistent: 1 });
    // as the range itself merged
    expect(mergeSuggestions([H(5, 10, "high", 20), Dc(5, 10, "high")]).suggestions[0]!.confidence).toBe("high");
  });

  it("a collapsed ד\"ה span inside the section agrees too; one reaching past the section's end conflicts, as the ranges did", () => {
    expect(mergeSuggestions([Hs(5, 10, 20, "high"), Dc(5, 15, "high", { line: 15, end: 16 })]).stats).toMatchObject({ consistent: 1, conflicts: 0 });
    expect(mergeSuggestions([Hs(5, 10, 20, "high"), Dc(5, 19, "high", { line: 19, end: 22 })]).stats).toMatchObject({ consistent: 0, settled: 1, outweighed: 1 });
  });

  it("a link that writes only the first line of its span is never certain: not by itself, not by agreement", () => {
    const alone = mergeSuggestions([Hs(5, 10, 20, "certain")]).suggestions[0]!;
    expect(alone.confidence).toBe("high");
    expect(alone.warnings.map((w) => w.code)).toContain("range/sefaria-not-exact");
    // headings and a ד"ה quote over the same span: one link, two engines — still high
    const both = mergeSuggestions([Hs(5, 10, 20, "high"), Dc(5, 10, "high", { line: 10, end: 20 })]);
    expect(both.stats.agreements).toBe(1);
    expect(both.suggestions[0]!.confidence).toBe("high");
    // a precise line inside it keeps its own certainty
    expect(mergeSuggestions([Hs(5, 10, 20, "certain"), Dc(5, 15, "certain")]).suggestions[0]!).toMatchObject({ engine: "dibur-hamatchil", confidence: "certain" });
  });

  it("the library's links inside the span do not count as contradicting it", () => {
    const ours = Array.from({ length: 30 }, (_, i) => Hs(i, i * 10, i * 10 + 9, "certain"));
    const inside = Array.from({ length: 30 }, (_, i) => linePairKey({ source: side(C, i), target: side(B, i * 10 + 5) }));
    expect(mergeSuggestions(ours, { reference: inside }).stats.contradictedPairs).toBe(0);
    const outside = Array.from({ length: 30 }, (_, i) => linePairKey({ source: side(C, i), target: side(B, i * 10 + 50) }));
    expect(mergeSuggestions(ours, { reference: outside }).stats.contradictedPairs).toBe(1);
  });
});

describe("mergeSuggestions — a book pair whose engines mostly disagree", () => {
  // positions 0..11: headings and dibur-hamatchil point at different lines (the Rif's own dapim read as the Talmud's)
  const conflicting = Array.from({ length: 12 }, (_, i) => [H(i, i, "certain"), D(i, i + 40, "high")]).flat();
  const agreeing = [H(20, 50, "certain", 60), D(20, 55, "high"), H(21, 50, "certain", 60), D(21, 56, "high")];
  const alone = H(30, 70, "certain");

  it("no single engine's 'certain' is trusted there: it drops to 'possible' with the reason", () => {
    const { suggestions, stats } = mergeSuggestions([...conflicting, ...agreeing, alone]);
    expect(stats.suspectPairs).toBe(1);
    const s = suggestions.find((x) => x.source.line === 30)!;
    expect(s.confidence).toBe("possible");
    expect(s.rules).toContain("maxlink/pair-disagree");
    expect(s.warnings.some((w) => w.text.includes("12"))).toBe(true);
    // lines where the engines agree keep their level
    expect(suggestions.find((x) => x.target.line === 20 || x.source.line === 55)!.confidence).toBe("high");
  });

  it("a few conflicts in a pair that mostly agrees change nothing", () => {
    const many = Array.from({ length: 60 }, (_, i) => [H(100 + i, 100 + i, "certain", 100 + i + 2), D(100 + i, 101 + i, "high")]).flat();
    const { suggestions, stats } = mergeSuggestions([...conflicting, ...many, alone]);
    expect(stats.suspectPairs).toBe(0);
    expect(suggestions.find((x) => x.source.line === 30)!.confidence).toBe("certain");
  });
});

describe("mergeSuggestions — a book pair whose suggestions contradict the library's own links", () => {
  // the library links commentary line i to base line i + 100; the engines (both fooled alike) say line i
  const ours = Array.from({ length: 30 }, (_, i) => [H(i, i, "certain", i + 1), D(i, i, "certain")]).flat();
  const libraryHas = (n: number) => Array.from({ length: n }, (_, i) => linePairKey({ source: side(C, i), target: side(B, i + 100) }));

  it("no suggestion of that pair is 'certain', even where two engines agree", () => {
    const { suggestions, stats } = mergeSuggestions(ours, { reference: libraryHas(30) });
    expect(stats.contradictedPairs).toBe(1);
    expect(new Set(suggestions.map((s) => s.confidence))).toEqual(new Set(["possible"]));
    expect(suggestions[0]!.rules).toContain("maxlink/contradicts-library");
    expect(suggestions[0]!.warnings.at(-1)!.text).toContain("30");
  });

  it("too few library links, or links that agree, change nothing", () => {
    expect(mergeSuggestions(ours, { reference: libraryHas(10) }).stats.contradictedPairs).toBe(0);
    const agreeing = Array.from({ length: 30 }, (_, i) => linePairKey({ source: side(C, i), target: side(B, i) }));
    const { suggestions, stats } = mergeSuggestions(ours, { reference: agreeing });
    expect(stats.contradictedPairs).toBe(0);
    expect(suggestions.every((s) => s.confidence === "certain")).toBe(true);
  });
});

describe("mergeSuggestions — already existing", () => {
  it("marks a link the database or the project already has, judged on the merged suggestion", () => {
    const db = new Set([linePairKey(H(5, 10, "certain").suggestion)]);
    const { suggestions, stats } = mergeSuggestions([H(5, 10, "certain"), D(5, 10, "high"), H(6, 11, "certain")], { existing: (s) => (db.has(linePairKey(s)) ? "db" : null) });
    expect(suggestions[0]!.rules).toContain("maxlink/exists-db");
    expect(suggestions[0]!.reasons.at(-1)!.text).toContain("במסד");
    expect(suggestions[1]!.rules.some((r) => r.startsWith("maxlink/exists"))).toBe(false);
    expect(stats.existing).toBe(1);
  });
});

/* ---------------- properties ---------------- */

const CONF: Confidence[] = ["certain", "high", "possible", "ambiguous", "none"];
const item = fc.oneof(
  fc.record({ c: fc.integer({ min: 0, max: 4 }), b: fc.integer({ min: 0, max: 5 }), conf: fc.constantFrom(...CONF), end: fc.option(fc.integer({ min: 0, max: 3 }), { nil: undefined }) }).map(({ c, b, conf, end }) => H(c, b, conf, end === undefined ? undefined : b + end)),
  fc.record({ c: fc.integer({ min: 0, max: 4 }), b: fc.integer({ min: 0, max: 5 }), conf: fc.constantFrom(...CONF) }).map(({ c, b, conf }) => D(c, b, conf)),
  fc.record({ m: fc.integer({ min: 0, max: 2 }), at: fc.constantFrom(1, 5), n: fc.integer({ min: 0, max: 2 }), conf: fc.constantFrom(...CONF) }).map(({ m, at, n, conf }) => F(m, at, n, conf)),
);

describe("mergeSuggestions — properties", () => {
  it("is independent of the order of its input", () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 30 }), fc.integer(), (items, seed) => {
        const shuffled = [...items].map((x, i) => ({ x, k: Math.sin(seed + i) })).sort((a, b) => a.k - b.k).map((p) => p.x);
        expect(mergeSuggestions(shuffled)).toEqual(mergeSuggestions(items));
      }),
      { numRuns: 300 },
    );
  });

  it("is idempotent: merging a merged list again changes nothing", () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 30 }), (items) => {
        const once = mergeSuggestions(items);
        const twice = mergeSuggestions(once.suggestions);
        expect(twice.suggestions).toEqual(once.suggestions);
        expect(mergeItems(once.suggestions).length).toBeGreaterThanOrEqual(once.suggestions.length);
      }),
      { numRuns: 300 },
    );
  });

  it("never loses a link: every distinct pair of positions is still there or folded into a precise one inside it", () => {
    fc.assert(
      fc.property(fc.array(item, { maxLength: 30 }), (items) => {
        const { suggestions } = mergeSuggestions(items);
        const ids = new Set(mergeItems(suggestions).map((m) => m.suggestion.id));
        for (const it of items) expect(ids.has(it.suggestion.id)).toBe(true);
        // and the merge never makes a confidence certain that no member had, unless two engines agreed
        for (const s of suggestions)
          if (s.confidence === "certain" && s.engines.length < 2) expect(s.members.some((m) => m.suggestion.confidence === "certain")).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

describe("mergeSuggestions — citations (a single-book engine)", () => {
  /** citations: the citing line (span 10-20 in its id) → the cited line(s), type reference, no anchor (Sefaria target) */
  const Q = (c: number, b: number, conf: Confidence, at = 10, end?: number): MergeItem => ({
    suggestion: { ...sg("citations", side(C, c), side(B, b, end), conf, { declaredType: "reference" }), id: `citations:${C.key}:${c}@${at}-${at + 10}>${B.key}:${b}${end !== undefined ? `-${end}` : ""}` },
    focus: C.key,
  });

  it("a commentary line on one verse that cites another is two links, not a conflict", () => {
    const { suggestions, stats } = mergeSuggestions([H(5, 10, "certain"), Q(5, 30, "certain")]);
    expect(suggestions).toHaveLength(2);
    expect(suggestions.every((s) => s.confidence === "certain" && !s.rules.includes("maxlink/conflict"))).toBe(true);
    expect(stats.conflicts).toBe(0);
  });

  it("two mentions in one line are two positions; a range citation is not folded into a structural line", () => {
    const { suggestions } = mergeSuggestions([Q(5, 30, "certain", 10), Q(5, 40, "high", 50), H(5, 31, "certain"), Q(6, 30, "certain", 10, 45)]);
    expect(suggestions).toHaveLength(4);
  });

  it("the same two lines from a citation and a structural engine are one link, raised by the agreement", () => {
    const { suggestions, stats } = mergeSuggestions([H(5, 10, "high"), Q(5, 10, "high")]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.confidence).toBe("certain");
    expect(stats.agreements).toBe(1);
  });

  it("citations neither make a pair suspect nor count against the library's links", () => {
    const structural = Array.from({ length: 30 }, (_, i) => H(i, i, "certain"));
    const cites = Array.from({ length: 30 }, (_, i) => Q(i, i + 200, "certain"));
    const reference = Array.from({ length: 30 }, (_, i) => linePairKey({ source: side(C, i), target: side(B, i) }));
    const { suggestions, stats } = mergeSuggestions([...structural, ...cites], { reference });
    expect(stats.suspectPairs).toBe(0);
    expect(stats.contradictedPairs).toBe(0);
    expect(suggestions.every((s) => s.confidence === "certain")).toBe(true);
  });
});

describe("mergeSuggestions — regression: nothing absorbed on the way is lost", () => {
  it("a range absorbed by a precise line, which is then folded into a supported range, survives as a member", () => {
    // found by the property test (seed 324744211): [0-1] certain, [1-2] ambiguous and [1] none from one line
    const T = { key: "t:1", title: "ביאור על בראשית", origin: "otzaria" as const };
    const D = { key: "d:1", title: "בראשית", origin: "otzaria" as const };
    const at = (line: number, end: number | undefined, confidence: Confidence, score: number): MergeItem => ({
      suggestion: { id: `headings:t:1#3>d:1#${line}-${end ?? ""}`, engine: "headings", source: { book: T, line: 3 }, target: { book: D, line, ...(end !== undefined && { end }) }, declaredType: "source", heRef2: "", score, confidence, reasons: [{ code: "headings/r", text: "x" }], rules: ["headings/rule"], alternatives: [], warnings: [] },
      focus: T.key,
    });
    const items = [at(0, 1, "certain", 1), at(1, 2, "ambiguous", 0.8), at(1, undefined, "none", 0.3)];
    const { suggestions } = mergeSuggestions(items);
    const ids = mergeItems(suggestions).map((m) => m.suggestion.id);
    for (const it of items) expect(ids).toContain(it.suggestion.id);
    expect(new Set(ids).size).toBe(ids.length); // each once
  });
});
