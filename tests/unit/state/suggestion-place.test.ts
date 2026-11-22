import { describe, expect, it } from "vitest";
import type { BookRef, LinkSide } from "../../../src/core/links/model";
import { placeText } from "../../../src/state/suggestions";

/*
 * Issue 12: the suggestions list showed the source line but only the target's place NAME ("בראשית, א, ב"), and in a
 * text book without verse headings the name is the same for every row of a chapter. The number of the target line
 * (1-based, like the readers and the links list), or its range, or the whole cited span, is told in one place.
 */
const B: BookRef = { key: "t:1", title: "בראשית", origin: "otzaria" };
const at = (line: number, end?: number): LinkSide => ({ book: B, line, ...(end !== undefined && { end }) });

describe("placeText", () => {
  it("one line: 'שורה N', 1-based", () => {
    expect(placeText(at(0))).toBe("שורה 1");
    expect(placeText(at(11))).toBe("שורה 12");
  });

  it("a range: 'שורות A–B'; an end that is not after the start is one line", () => {
    expect(placeText(at(11, 14))).toBe("שורות 12–15");
    expect(placeText(at(11, 11))).toBe("שורה 12");
  });

  it("a cited span wider than the stored line: the whole span, since the link's own line is only its start", () => {
    expect(placeText(at(11), { citedSpan: { line: 11, end: 14 } })).toBe("שורות 12–15");
    expect(placeText(at(11), { citedSpan: { line: 11, end: 11 } })).toBe("שורה 12");
  });

  it("lines are numbered as in the readers, with no digit grouping (a line number is a place, not a quantity)", () => {
    expect(placeText(at(1233))).toBe("שורה 1234");
  });
});
