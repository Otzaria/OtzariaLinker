import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hebrewTokens, searchKey, visibleSlice } from "../../../src/matching/hebrew-tokens";
import { matchStep } from "../../../src/matching/token-match";
import { idfFactors, staticWeight, wordWeight } from "../../../src/matching/word-weights";

const keys = (s: string) => hebrewTokens(s).map((t) => t.key);

describe("hebrewTokens: search keys with raw offsets", () => {
  it("maqaf U+05BE separates words (the link-generator joined them)", () => {
    expect(keys("כָּל־הָאָדָם")).toEqual(["כל", "האדמ"]);
    expect(keys("יְהִי־אוֹר")).toEqual(["יהי", "אור"]);
  });

  it("paseq and sof pasuq separate too", () => {
    expect(keys("אֱלֹהִים׀לָאוֹר")).toEqual(["אלהימ", "לאור"]);
    expect(keys("הָאָֽרֶץ׃וְהָאָרֶץ")).toEqual(["הארצ", "והארצ"]);
  });

  it("nikud and cantillation are dropped from the key, final letters unified", () => {
    expect(keys("בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים")).toEqual(["בראשית", "ברא", "אלהימ"]);
    expect(searchKey("שלום")).toBe(searchKey("שלומ"));
  });

  it("inline tags are zero-width: a word split by <big> is one token starting at its first letter", () => {
    const html = "<big>בְּ</big>רֵאשִׁ֖ית בָּרָא";
    const [t] = hebrewTokens(html);
    expect(t!.key).toBe("בראשית");
    expect(html.slice(t!.rawStart, t!.rawStart + 1)).toBe("ב");
    expect(visibleSlice(html, t!.rawStart, t!.rawEnd)).toBe("בְּרֵאשִׁ֖ית");
  });

  it("line-breaking tags and entities separate words", () => {
    expect(keys("אחד<br>שנים")).toEqual(["אחד", "שנימ"]);
    expect(keys("אחד&nbsp;שנים&thinsp;שלשה")).toEqual(["אחד", "שנימ", "שלשה"]);
  });

  it("gershayim inside a word marks an acronym; a trailing geresh a truncation; wrapping quotes vanish", () => {
    const [a, b, c] = hebrewTokens('ת"ר ר׳ "שמע"');
    expect(a).toMatchObject({ key: "תר", acronym: true, truncated: false });
    expect(b).toMatchObject({ key: "ר", acronym: false, truncated: true });
    expect(c).toMatchObject({ key: "שמע", acronym: false, truncated: false });
    expect(hebrewTokens("רש&quot;י")[0]).toMatchObject({ key: "רשי", acronym: true });
    expect(hebrewTokens("רש''י")[0]).toMatchObject({ key: "רשי", acronym: true });
  });

  it("a truncation's raw span includes its geresh; a word's span includes its last vowel", () => {
    const html = "גמ׳ קָרָא";
    const [g, k] = hebrewTokens(html);
    expect(html.slice(g!.rawStart, g!.rawEnd)).toBe("גמ׳");
    expect(html.slice(k!.rawStart, k!.rawEnd)).toBe("קָרָא");
  });

  it("an unclosed < hides the rest of the line, like the generator's countVisibleChars", () => {
    expect(keys("אחד <שנים שלשה")).toEqual(["אחד"]);
  });

  it("property: every token is a slice of the untouched input whose letters ARE its key", () => {
    const piece = fc.constantFrom("א", "ב", "ג", "ך", "ם", "ן", "ף", "ץ", "ש", "ת", "ְ", "ּ", "ֹ", "֑", "־", "׃", " ", '"', "׳", "<b>", "</b>", "<br>", "&nbsp;", ".", ",", "1");
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 60 }), (parts) => {
        const html = parts.join("");
        const copy = `${html}`;
        for (const t of hebrewTokens(html)) {
          expect(t.rawStart).toBeGreaterThanOrEqual(0);
          expect(t.rawEnd).toBeLessThanOrEqual(html.length);
          const letters = visibleSlice(html, t.rawStart, t.rawEnd).replace(/[^א-ת]/g, "");
          expect(searchKey(letters)).toBe(t.key);
        }
        expect(html).toBe(copy);
      }),
    );
  });
});

describe("matchStep: bridges without a dictionary", () => {
  const T = hebrewTokens;
  it("exact and fuzzy words", () => {
    expect(matchStep(T("אלהים"), 0, T("אֱלֹהִים"), 0)).toMatchObject({ kind: "exact", sim: 1 });
    expect(matchStep(T("מצוה"), 0, T("מצווה"), 0)?.kind).toBe("fuzzy");
    expect(matchStep(T("בונה"), 0, T("בֹּנֶה"), 0)?.kind).toBe("fuzzy");
    expect(matchStep(T("לא"), 0, T("לה"), 0)).toBeNull();
  });

  it("an acronym WRITTEN with gershayim matches words by initials, also with a glued prefix letter", () => {
    expect(matchStep(T('ת"ר'), 0, T("תנו רבנן"), 0)).toMatchObject({ a: 1, b: 2, kind: "acronym" });
    expect(matchStep(T("תנו רבנן"), 0, T('ת"ר'), 0)).toMatchObject({ a: 2, b: 1, kind: "acronym" });
    expect(matchStep(T('וא"ר'), 0, T("ואמר רבי"), 0)).toMatchObject({ a: 1, b: 2 });
    expect(matchStep(T("תר"), 0, T("תנו רבנן"), 0)).toBeNull(); // unmarked: never expanded (BUG-07)
  });

  it("truncations: ר׳ ↔ רבי, מתני׳ ↔ מתניתין, ה׳ ↔ יהוה — but ר׳ is not any word starting with ר", () => {
    expect(matchStep(T("ר׳"), 0, T("רבי"), 0)?.kind).toBe("truncation");
    expect(matchStep(T("ר׳"), 0, T("ראה"), 0)).toBeNull();
    expect(matchStep(T("מתני׳"), 0, T("מתניתין"), 0)?.kind).toBe("truncation");
    expect(matchStep(T("ה׳"), 0, T("יְהוָה"), 0)?.kind).toBe("truncation");
    expect(matchStep(T("לה׳"), 0, T("לַיהוָה"), 0)?.kind).toBe("truncation");
    expect(matchStep(T("ה׳"), 0, T("הארץ"), 0)).toBeNull();
    expect(matchStep(T("ד׳"), 0, T("יהוה"), 0)).toBeNull();
  });

  it("one word ↔ two glued words, and fixed Aramaic contractions", () => {
    expect(matchStep(T("והאמר"), 0, T("והא אמר"), 0)).toMatchObject({ a: 1, b: 2, kind: "split" });
    expect(matchStep(T("קמשמע"), 0, T("קא משמע"), 0)).toMatchObject({ a: 1, b: 2, kind: "split" });
  });
});

describe("word weights (link-generator wordWeights.ts)", () => {
  it("stop words, short and long words", () => {
    expect(staticWeight("של")).toBe(0.35);
    expect(staticWeight("אב")).toBe(0.45);
    expect(staticWeight("שמים")).toBe(1);
    expect(staticWeight("בראשית")).toBe(1.25);
  });
  it("IDF: frequent words lose weight, rare ones gain up to the 1.30 cap", () => {
    const lines = [...Array.from({ length: 200 }, () => ["אמר", "דבר"]), ["נדיר", "אמר"]];
    const idf = idfFactors(lines);
    expect(wordWeight("אמר", idf)).toBe(0.25);
    expect(wordWeight("נדיר", idf)).toBe(1.3);
    expect(wordWeight("נדיר", idf, false)).toBe(1);
  });
});

describe("hostile input (security review A8)", () => {
  it("a line of bare '&' is tokenized in linear time: the entity scan looks at most 10 characters ahead", () => {
    const time = (n: number) => {
      const line = "&א ".repeat(n);
      const t0 = performance.now();
      hebrewTokens(line);
      return performance.now() - t0;
    };
    time(2_000); // warm-up
    const small = Math.max(time(20_000), 1);
    const large = time(80_000);
    // 4× the input: a quadratic scan grew ~16×; linear stays well under 8×
    expect(large / small).toBeLessThan(8);
  });
});
