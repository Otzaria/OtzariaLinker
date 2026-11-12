import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toGematria } from "../../../../src/core/text/gematria";
import { citationTokens, numeralOf, strictValue } from "../../../../src/linking/automatic/citations";

const tok = (s: string) => citationTokens(s)[0];

describe("citations: strict numerals", () => {
  it("reads canonical numerals, with or without quote marks", () => {
    expect(numeralOf(tok('כ"ג'))).toEqual({ n: 23, form: "gershayim", common: false });
    expect(numeralOf(tok("ג'"))).toEqual({ n: 3, form: "geresh", common: false });
    expect(numeralOf(tok("קכג"))).toEqual({ n: 123, form: "bare", common: false });
    expect(numeralOf(tok('ט"ו'))?.n).toBe(15);
    expect(numeralOf(tok('ט"ז'))?.n).toBe(16);
    expect(numeralOf(tok("17"))).toEqual({ n: 17, form: "digits", common: false });
    expect(numeralOf(tok('רפ"ח'))?.n).toBe(288);
  });

  it("refuses words that only SUM to a number (REUSE_MATRIX §5.1: strict in prose)", () => {
    for (const w of ["שבת", "יה", "יו", "הקדמה", "ברא", "אב", "כי", "הם"]) expect(numeralOf(tok(w)), w).toBeNull();
  });

  it("an acronym is not a numeral: the gershayim must sit before the last letter", () => {
    expect(numeralOf(tok('ב"ק'))).toBeNull(); // 102 is written ק"ב
    expect(numeralOf(tok('א"ר'))).toBeNull();
    expect(numeralOf(tok('רמב"ם'))).toBeNull(); // gershayim not before the last letter
    expect(numeralOf(tok('ק"ב'))?.n).toBe(102);
  });

  it("flags canonical numerals that are everyday words, and ה' (the divine name)", () => {
    for (const w of ["לא", "של", "שם", "פה", "עד", "לו", "נח"]) expect(numeralOf(tok(w))?.common, w).toBe(true);
    expect(numeralOf(tok("ה'"))?.common).toBe(true);
    expect(numeralOf(tok('ל"א'))?.common).toBe(false);
    expect(numeralOf(tok("כח"))?.common).toBe(false);
  });

  it("property: every n in 1..999 written by toGematria reads back as n", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999 }), (n) => {
        expect(strictValue(toGematria(n))).toBe(n);
        const g = toGematria(n);
        const quoted = g.length > 1 ? `${g.slice(0, -1)}"${g.slice(-1)}` : `${g}'`;
        expect(numeralOf(tok(quoted))?.n).toBe(n);
      }),
    );
  });

  it("property: a reordered numeral (non-canonical) is refused", () => {
    fc.assert(
      fc.property(fc.integer({ min: 11, max: 999 }), (n) => {
        const g = toGematria(n);
        const r = [...g].reverse().join("");
        if (r !== g && !(n % 100 === 15 || n % 100 === 16)) expect(strictValue(r)).toBeNull();
      }),
    );
  });
});
