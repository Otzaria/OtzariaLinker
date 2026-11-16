import { describe, expect, it } from "vitest";
import type { BookRef, LinkSide } from "../../../src/core/links/model";
import type { Confidence, EngineId, Suggestion } from "../../../src/linking/automatic";
import { mergeSuggestions } from "../../../src/linking/merge";
import { rejectionKey, rejectionKeys } from "../../../src/state/suggestions";

const C: BookRef = { key: "s2:1", title: "ביאור על בראשית", origin: "otzaria" };
const B: BookRef = { key: "s1:1", title: "בראשית", origin: "otzaria" };
const side = (book: BookRef, line: number): LinkSide => ({ book, line });
const sg = (engine: EngineId, source: LinkSide, target: LinkSide, confidence: Confidence, anchor?: number): Suggestion => ({
  id: `${engine}:${source.line}>${target.line}`, engine, source, target, declaredType: "source", heRef2: "", score: 0.9, confidence, reasons: [], rules: [], alternatives: [], warnings: [], ...(anchor !== undefined && { anchor: { rawStart: anchor } }),
});
const H = sg("headings", side(C, 4), side(B, 7), "high");
const D = sg("dibur-hamatchil", side(B, 7), side(C, 4), "high", 2);

describe("rejectionKeys", () => {
  it("a plain suggestion has exactly its rejectionKey (saved projects keep working)", () => {
    expect(rejectionKeys(H)).toEqual([rejectionKey(H)]);
  });

  it("a merged suggestion carries every agreeing engine's key, so a rejection holds whichever engine represents it next time", () => {
    const both = mergeSuggestions([{ suggestion: H, focus: C.key }, { suggestion: D, focus: C.key }]).suggestions[0]!;
    const onlyHeadings = mergeSuggestions([{ suggestion: H, focus: C.key }]).suggestions[0]!;
    expect(both.engine).toBe("dibur-hamatchil");
    const rejected = new Set(rejectionKeys(both));
    expect(rejected.has(rejectionKey(H))).toBe(true); // a single-engine headings run sees it as rejected
    expect(rejectionKeys(onlyHeadings).some((k) => rejected.has(k))).toBe(true);
  });

  it("the engine-free key does not depend on session book keys", () => {
    const other = { ...C, key: "s9:1" };
    const moved = mergeSuggestions([{ suggestion: { ...H, source: side(other, 4) }, focus: other.key }]).suggestions[0]!;
    const here = mergeSuggestions([{ suggestion: H, focus: C.key }]).suggestions[0]!;
    expect(rejectionKeys(moved).at(-1)).toBe(rejectionKeys(here).at(-1));
  });
});
