import { describe, expect, it } from "vitest";
import { ABBREVIATIONS, abbreviationOf, expansionsOf } from "../../../src/matching/abbreviations";
import { hebrewTokens, searchKey } from "../../../src/matching/hebrew-tokens";
import { matchStep } from "../../../src/matching/token-match";

const tok = (s: string) => hebrewTokens(s)[0]!;

describe("abbreviations: the shared table", () => {
  it("a marked abbreviation and the readings it stands for", () => {
    expect(expansionsOf(tok('אע"פ'))).toEqual([["אפ", "על", "פי"]]);
    expect(expansionsOf(tok('ר"ל')).map((e) => e.join(" "))).toEqual(["ריש לקיש", "רוצה לומר"]);
    expect(expansionsOf(tok("אפי'"))).toEqual([["אפילו"]]);
  });

  it("without its quote marks only the forms that are no word of their own", () => {
    expect(abbreviationOf(tok("אעפ"))?.written).toBe('אע"פ');
    // "אכ" / "מט" / "שמ" unmarked are words or too ambiguous: not expanded
    for (const w of ["אכ", "מט", "שמ", "בה", "רל"]) expect(abbreviationOf(tok(w))).toBeNull();
  });

  it("every entry is a valid search key with expansions of whole words", () => {
    for (const a of ABBREVIATIONS) {
      expect(searchKey(a.written)).toMatch(/^[א-ת]+$/);
      for (const e of a.expansions) expect(searchKey(e).split(" ").length).toBeGreaterThan(0);
    }
  });

  it("token-match bridges an unmarked table form, never an unmarked word outside the table (BUG-07)", () => {
    expect(matchStep(hebrewTokens("אעפ שאמרו"), 0, hebrewTokens("אף על פי שאמרו"), 0)).toMatchObject({ a: 1, b: 3, kind: "acronym" });
    // "תר" without gershayim is a word: it is not תנו רבנן
    expect(matchStep(hebrewTokens("תר"), 0, hebrewTokens("תנו רבנן"), 0)).toBeNull();
  });
});
