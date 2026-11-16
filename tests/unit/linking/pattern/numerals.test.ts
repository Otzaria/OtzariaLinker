import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toGematria } from "../../../../src/core/text/gematria";
import { compilePattern, describeLevels, parseAmud, parseRefNumeral } from "../../../../src/linking/automatic/pattern";

/** every way a number is written in a reference: plain, with a final geresh, with gershayim before the last letter */
function spellings(n: number): string[] {
  const g = toGematria(n);
  const out = [g, `${g}'`, `${g}׳`, String(n)];
  if (g.length > 1) out.push(`${g.slice(0, -1)}"${g.slice(-1)}`, `${g.slice(0, -1)}״${g.slice(-1)}`);
  return out;
}

describe("parseRefNumeral (property)", () => {
  it("every canonical spelling of 1..899 reads back as the number", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 899 }), (n) => {
        for (const s of spellings(n)) expect(parseRefNumeral(s)?.n).toBe(n);
      }),
      { numRuns: 400 },
    );
  });

  it("a reordered spelling of a multi-letter numeral is never read (קכג yes, גכק no)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 11, max: 899 }), (n) => {
        const g = toGematria(n);
        const rev = [...g].reverse().join("");
        fc.pre(rev !== g && g !== "טו" && g !== "טז");
        expect(parseRefNumeral(rev)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  it("a gershayim is accepted only before the last letter, a geresh only at the end", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 899 }).filter((n) => toGematria(n).length >= 3), (n) => {
        const g = toGematria(n);
        expect(parseRefNumeral(`${g[0]}"${g.slice(1)}`)).toBeNull();
        expect(parseRefNumeral(`${g[0]}'${g.slice(1)}`)).toBeNull();
      }),
      { numRuns: 200 },
    );
  });

  it("never throws, and any number it reads is positive", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 8 }), (s) => {
        const r = parseRefNumeral(s);
        expect(r === null || r.n > 0).toBe(true);
      }),
    );
  });
});

describe("parseRefNumeral (cases)", () => {
  it("15 and 16: טו/טז, and the old spellings יה/יו", () => {
    expect(["טו", "ט\"ו", "יה", "קט\"ו", "קיה"].map((s) => parseRefNumeral(s)?.n)).toEqual([15, 15, 15, 115, 115]);
    expect(["טז", "יו", "רי\"ו"].map((s) => parseRefNumeral(s)?.n)).toEqual([16, 16, 216]);
  });

  it("ordinal words after a kind word: פרק שני, שער ראשון", () => {
    expect(parseRefNumeral("שני")?.n).toBe(2);
    expect(parseRefNumeral("ראשון")?.n).toBe(1);
    expect(parseRefNumeral("ראשון", false)).toBeNull();
  });

  it("everyday words are not numbers; numeral-words are flagged unless quoted; שם is ibid", () => {
    for (const w of ["זה", "בו", "הוא", "כי", "אם", "גם"]) expect(parseRefNumeral(w)).toBeNull();
    expect(parseRefNumeral("לא")).toEqual({ n: 31, marked: false, ambiguous: true });
    expect(parseRefNumeral('ל"א')).toEqual({ n: 31, marked: true, ambiguous: false });
    expect(parseRefNumeral("שם")).toBeNull();
    expect(parseRefNumeral('ש"מ')?.n).toBe(340);
  });

  it("final letters only at the end; digits 1..9999", () => {
    expect(parseRefNumeral("תם")?.n).toBe(440);
    expect(parseRefNumeral("םת")).toBeNull();
    expect(parseRefNumeral("0")).toBeNull();
    expect(parseRefNumeral("1234")?.n).toBe(1234);
  });
});

describe("parseAmud", () => {
  it("reads every side notation", () => {
    expect([".", "ע\"א", "ע״א", "עמוד א", "ע' א", "א", "א'"].map(parseAmud)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect([":", "ע\"ב", "עמוד ב", "ב'"].map(parseAmud)).toEqual([2, 2, 2, 2]);
    expect(["ג", "עמוד", "", undefined].map(parseAmud)).toEqual([null, null, null, null]);
  });
});

describe("templates", () => {
  it("placeholders in Hebrew or by kind id; the levels are described in order", () => {
    expect(describeLevels("סימן\\s{סימן}\\sסעיף\\s{סעיף}\\sס\"ק\\s{ס\"ק}")).toBe('סימן › סעיף › סעיף קטן');
    expect(describeLevels("פרק\\s{perek}\\sהלכה\\s{halacha}")).toBe("פרק › הלכה");
    expect(describeLevels("(?:דף\\s){דף}\\s?{עמוד}")).toBe("דף");
  });

  it("an unknown placeholder or an unsafe expression is refused with a reason; a quantifier is not a placeholder", () => {
    const bad = compilePattern("סימן {שמש}");
    expect(bad.ok).toBe(false);
    expect(bad.ok ? "" : bad.reason).toContain("{שמש}");
    expect(compilePattern("({סימן})+").ok).toBe(false);
    expect(compilePattern("סימן\\s{1,3}{סימן}").ok).toBe(true);
  });
});
