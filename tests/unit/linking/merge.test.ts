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
  it("different targets for the same commentary line from different engines → ambiguous, each with the other as alternative", () => {
    const { suggestions, stats } = mergeSuggestions([H(5, 10, "certain"), D(5, 14, "high")]);
    expect(suggestions).toHaveLength(2);
    for (const s of suggestions) {
      expect(s.confidence).toBe("ambiguous");
      expect(s.rules).toContain("maxlink/conflict");
      expect(s.warnings.some((w) => w.code === "maxlink/conflict")).toBe(true);
    }
    const h = suggestions.find((s) => s.engine === "headings")!;
    expect(h.alternatives[0]!.target).toEqual(side(B, 14));
    expect(stats.conflicts).toBe(2);
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
