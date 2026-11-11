import { describe, expect, it } from "vitest";
import { normalize, skeleton, stem, stripNikud } from "../../../src/core/text/hebrew";
import { levenshtein, phraseSimilarity, wordSimilarity } from "../../../src/matching/similarity";

describe("השוואת טקסט עברי (legacy §10)", () => {
  it("הסרת ניקוד", () => expect(stripNikud("שְׁמַע")).toBe("שמע"));
  it("נרמול מרחיב ראשי תיבות מבניים", () => {
    expect(normalize("סי׳ יב")).toBe("סימן יב");
    expect(normalize('ס"ק ג')).toBe("סעיף קטן ג");
  });
  it("נרמול מסיר גרשיים", () => expect(normalize('רש"י')).toBe("רשי"));
  it("אות שימוש מוסרת רק כשנשאר שורש בן 3", () => {
    expect(stem("לבית")).toBe("בית");
    expect(stem("בן")).toBe("בן");
  });
  it("שלד כתיב מגשר מלא/חסר", () => expect(skeleton("מצווה")).toBe(skeleton("מצוה")));
  it("שלד מאחד סופיות ן/ם", () => expect(skeleton("יושבין")).toBe(skeleton("יושבים")));
  it("מרחק עריכה", () => {
    expect(levenshtein("אבג", "אבד")).toBe(1);
    expect(levenshtein("אב", "אב")).toBe(0);
  });
  it("מילה קצרה דורשת התאמה מדויקת", () => expect(wordSimilarity("לא", "לה")).toBe(0));
  it("דמיון: כתיב מלא מול חסר גבוה", () => expect(wordSimilarity("מצווה", "מצוה")).toBeGreaterThanOrEqual(0.85));
  it("דמיון ביטויים: זהה = 1", () => expect(phraseSimilarity("סימן א", "סימן א")).toBe(1));
  it("דמיון ביטויים: קיצור מול מלא = 1", () => expect(phraseSimilarity("סי׳ א", "סימן א")).toBe(1));
  it("דמיון ביטויים: ניקוד אינו משנה", () => expect(phraseSimilarity("שְׁמַע יִשְׂרָאֵל", "שמע ישראל")).toBe(1));
  it("דמיון ביטויים: טקסט שונה = נמוך", () => expect(phraseSimilarity("סימן א", "הלכות שבת")).toBeLessThan(0.4));

  it("נסיגה: phraseSimilarity סימטרי", () => {
    const w = ["סימן", "תורה", "ברורה", "הלכה", "שלמים", "מלכים", "ספרים"];
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 1500; i++) {
      const x = Array.from({ length: 1 + rnd(3) }, () => w[rnd(w.length)]).join(" ");
      const y = Array.from({ length: 1 + rnd(3) }, () => w[rnd(w.length)]).join(" ");
      expect(phraseSimilarity(x, y)).toBe(phraseSimilarity(y, x));
    }
  });
  it("נסיגה: Heb לא זורק על קלט שאינו מחרוזת", () => {
    expect(() => {
      wordSimilarity(1, 2);
      levenshtein(null, undefined);
      stem(5);
      phraseSimilarity({}, []);
    }).not.toThrow();
  });
});
