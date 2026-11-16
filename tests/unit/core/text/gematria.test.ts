import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fromGematria, parseNumberToken, toGematria } from "../../../../src/core/text/gematria";

describe("גימטריה (legacy §10)", () => {
  it("גימטריה 1/15/16/115 → א/טו/טז/קטו", () => {
    expect([1, 15, 16, 115].map(toGematria)).toEqual(["א", "טו", "טז", "קטו"]);
  });
  it("פענוח גימטריה יב=12, טו=15", () => {
    expect(fromGematria("יב")).toBe(12);
    expect(fromGematria("טו")).toBe(15);
  });
  it("מחרוזת לא-עברית אינה גימטריה", () => expect(fromGematria("abc")).toBeNull());
  it("נסיגה: גימטריה מעל 1000 אינה ריקה", () => {
    expect(toGematria(1000)).not.toBe("");
    expect(toGematria(5000)).not.toBe("");
    expect(toGematria(1001)).not.toBe(toGematria(1));
  });
  it("round-trips 1..999 and ignores geresh/gershayim", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 999 }), (n) => fromGematria(toGematria(n)) === n));
    expect(fromGematria('קט"ו')).toBe(115);
    expect(fromGematria("ג׳")).toBe(3);
  });
  it("parseNumberToken accepts digits and (optionally) gematria", () => {
    expect(parseNumberToken(" 42 ")).toBe(42);
    expect(parseNumberToken("מב")).toBe(42);
    expect(parseNumberToken("מב", false)).toBeNull();
    expect(parseNumberToken(null)).toBeNull();
  });
});
