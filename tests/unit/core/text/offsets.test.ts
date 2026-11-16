import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { countVisibleChars, rawOffsetFromVisible, visibleUnits } from "../../../../src/core/text/offsets";

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

/*
 * Parity with the generator's HtmlCharCounter.kt (SeforimLibrary@23f1f8f1). Expected values were
 * traced by hand through the Kotlin source; these are the two places where v3 disagreed with it.
 */
describe("parity with the generator (HtmlCharCounter.kt)", () => {
  it("a '<' without '>' hides the rest of the line", () => {
    expect(countVisibleChars("א<ב ג")).toBe(1);
    expect(visibleUnits("א<ב ג")).toHaveLength(1);
  });
  it("an entity is at most 10 characters: ';' must come within 9 characters of '&'", () => {
    expect(countVisibleChars("&abcdefgh;")).toBe(1); // 10 chars → one unit
    expect(countVisibleChars("&abcdefghi;")).toBe(11); // 11 chars → '&' alone, then 10 plain chars
  });
  it("a cut inside an entity counts the partial entity character by character (generator quirk)", () => {
    expect(countVisibleChars("א&amp;ב", 4)).toBe(4);
    expect(countVisibleChars("א&amp;ב", 6)).toBe(2);
  });
  it("tags count zero; a closing '>' outside a tag is visible", () => {
    expect(countVisibleChars("<b>א</b>>")).toBe(2);
  });
});

/** Book-like HTML: Hebrew letters, spaces, tags, entities, stray < & ; > characters. */
const htmlish = fc
  .array(fc.constantFrom("א", "ב", "ג", " ", "<b>", "</b>", "<i>", "</i>", "&amp;", "&nbsp;", "<", "&", ";", ">", "abcdefghi"), { maxLength: 40 })
  .map((parts) => parts.join(""));

describe("אופסטים — תכונות", () => {
  it("never returns an offset beyond the string", () => {
    fc.assert(fc.property(htmlish, fc.integer({ min: -3, max: 60 }), (s, v) => rawOffsetFromVisible(s, v) <= s.length));
  });
  it("is monotonic in the visible index", () => {
    fc.assert(fc.property(htmlish, fc.nat(40), (s, v) => rawOffsetFromVisible(s, v) <= rawOffsetFromVisible(s, v + 1)));
  });
  it("the generator maps every exported offset back to the intended visible index", () => {
    fc.assert(
      fc.property(htmlish, (s) => {
        const total = visibleUnits(s).length;
        for (let v = 0; v <= total; v++) if (countVisibleChars(s, rawOffsetFromVisible(s, v)) !== v) return false;
        return true;
      }),
    );
  });
  it("visibleUnits and countVisibleChars agree on the whole line", () => {
    fc.assert(fc.property(htmlish, (s) => visibleUnits(s).length === countVisibleChars(s)));
  });
});
