import { describe, expect, it } from "vitest";
import type { BookRef, LinkSide } from "../../../src/core/links/model";
import type { Confidence, EngineId, Suggestion } from "../../../src/linking/automatic";
import { SUGGESTION_SORTS, sortSuggestions } from "../../../src/linking/automatic/sort";

/*
 * Issue 8: the suggestions table could only be filtered, in the engine's (book) order. A pure, deterministic sort:
 * by confidence (worst or best first, the score inside a level), and by type, engine, target book or state.
 * "book" is the engine's own order, untouched.
 */
const C: BookRef = { key: "t:1", title: "ביאור", origin: "otzaria" };
const B1: BookRef = { key: "d:1", title: "בראשית", origin: "otzaria" };
const B2: BookRef = { key: "d:2", title: "שמות", origin: "otzaria" };
const side = (book: BookRef, line: number): LinkSide => ({ book, line });
function sg(n: number, confidence: Confidence, score: number, more: Partial<Suggestion> = {}): Suggestion {
  return { id: `s${n}`, engine: "headings", source: side(C, n), target: side(B1, n), declaredType: "commentary", heRef2: "", score, confidence, reasons: [], rules: [], alternatives: [], warnings: [], ...more };
}
const ids = (l: readonly Suggestion[]) => l.map((s) => s.id);

const LIST = [
  sg(1, "certain", 1),
  sg(2, "possible", 0.7),
  sg(3, "ambiguous", 0.62),
  sg(4, "high", 0.9),
  sg(5, "possible", 0.65),
  sg(6, "high", 0.86),
  sg(7, "possible", 0.7), // same level and score as 2: the book order decides
];

describe("sortSuggestions", () => {
  it("'book' returns the engine's order and never mutates the input", () => {
    const copy = [...LIST];
    expect(ids(sortSuggestions(LIST, "book"))).toEqual(ids(LIST));
    expect(LIST).toEqual(copy);
    expect(sortSuggestions(LIST, "book")).toBe(LIST);
  });

  it("worst first: ambiguous before possible before high before certain, the lower score first inside a level", () => {
    expect(ids(sortSuggestions(LIST, "worst"))).toEqual(["s3", "s5", "s2", "s7", "s6", "s4", "s1"]);
  });

  it("best first: certain first, the higher score first inside a level, ties in book order", () => {
    expect(ids(sortSuggestions(LIST, "best"))).toEqual(["s1", "s4", "s6", "s2", "s7", "s5", "s3"]);
  });

  it("is deterministic and stable: the same input in any starting order gives the same result for score ties", () => {
    const shuffled = [LIST[6]!, LIST[1]!, LIST[0]!, LIST[4]!, LIST[2]!, LIST[5]!, LIST[3]!];
    // s2 and s7 tie on level and score: the engine order of THE INPUT breaks the tie
    expect(ids(sortSuggestions(shuffled, "worst")).filter((i) => i === "s2" || i === "s7")).toEqual(["s7", "s2"]);
    expect(ids(sortSuggestions(LIST, "worst"))).toEqual(ids(sortSuggestions(LIST, "worst")));
  });

  it("by type, by engine and by target book, then book order", () => {
    const list = [
      sg(1, "high", 0.9, { declaredType: "targum", engine: "footnotes", target: side(B2, 4) }),
      sg(2, "high", 0.9, { declaredType: "commentary", engine: "headings", target: side(B1, 9) }),
      sg(3, "high", 0.9, { declaredType: "commentary", engine: "dibur-hamatchil" as EngineId, target: side(B2, 1) }),
      sg(4, "high", 0.9, { declaredType: "commentary", engine: "headings", target: side(B1, 2) }),
    ];
    expect(ids(sortSuggestions(list, "type"))).toEqual(["s2", "s3", "s4", "s1"]);
    expect(ids(sortSuggestions(list, "engine"))).toEqual(["s3", "s1", "s2", "s4"]);
    // בראשית before שמות; inside a book by target line
    expect(ids(sortSuggestions(list, "target"))).toEqual(["s4", "s2", "s3", "s1"]);
  });

  it("by state: pending first, then approved, rejected, already there — the state comes from the caller", () => {
    const list = [sg(1, "high", 0.9), sg(2, "high", 0.9), sg(3, "high", 0.9), sg(4, "high", 0.9)];
    const st: Record<string, number> = { s1: 2, s2: 0, s3: 3, s4: 1 };
    expect(ids(sortSuggestions(list, "state", (s) => st[s.id]!))).toEqual(["s2", "s4", "s1", "s3"]);
  });

  it("lists every order once, with a Hebrew label, 'book' first (the default)", () => {
    expect(SUGGESTION_SORTS[0]!.id).toBe("book");
    expect(new Set(SUGGESTION_SORTS.map((x) => x.id)).size).toBe(SUGGESTION_SORTS.length);
    for (const o of SUGGESTION_SORTS) expect(o.label).toMatch(/\p{Script=Hebrew}/u);
  });
});
