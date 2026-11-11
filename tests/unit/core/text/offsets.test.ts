import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { countVisibleChars, rawOffsetFromVisible } from "../../../../src/core/text/offsets";

const RAW = "אב <b>ג</b> דה";

describe("אופסטים גלוי↔גולמי (legacy §10)", () => {
  it('אופסט גלוי→גולמי: "אב <b>ג</b> דה" 3..5 → 6..12', () => {
    expect(rawOffsetFromVisible(RAW, 3)).toBe(6);
    expect(rawOffsetFromVisible(RAW, 5)).toBe(12);
  });
  it("אופסט גולמי→גלוי הוא הפוך", () => {
    expect(countVisibleChars(RAW, 6)).toBe(3);
    expect(countVisibleChars(RAW, 12)).toBe(5);
  });
  it("ישות &amp; נספרת כתו גלוי אחד", () => {
    expect(rawOffsetFromVisible("א&amp;ב", 2)).toBe("א&amp;".length);
  });
  it("אופסט 0 הוא 0", () => expect(rawOffsetFromVisible("שלום", 0)).toBe(0));
  it("נסיגה: אופסט לא חורג ממחרוזת עם < בודד", () => expect(rawOffsetFromVisible("א<ב", 3)).toBeLessThanOrEqual(3));
  it("נסיגה: אופסט לא חורג ממחרוזת עם & בודד", () => expect(rawOffsetFromVisible("א&ב", 3)).toBeLessThanOrEqual(3));
});

/** Book-like HTML: Hebrew letters, spaces, a few tags and entities, and stray < & characters. */
const htmlish = fc
  .array(fc.constantFrom("א", "ב", "ג", " ", "<b>", "</b>", "<i>", "</i>", "&amp;", "&nbsp;", "<", "&", ";", ">"), { maxLength: 40 })
  .map((parts) => parts.join(""));

describe("אופסטים — תכונות", () => {
  it("never returns an offset beyond the string", () => {
    fc.assert(fc.property(htmlish, fc.nat(60), (s, v) => rawOffsetFromVisible(s, v) <= s.length));
  });
  it("is monotonic in the visible index", () => {
    fc.assert(fc.property(htmlish, fc.nat(40), (s, v) => rawOffsetFromVisible(s, v) <= rawOffsetFromVisible(s, v + 1)));
  });
  it("count(raw(v)) === v for every reachable visible index", () => {
    fc.assert(
      fc.property(htmlish, (s) => {
        const total = countVisibleChars(s, s.length);
        for (let v = 0; v <= total; v++) if (countVisibleChars(s, rawOffsetFromVisible(s, v)) !== v) return false;
        return true;
      }),
    );
  });
});
