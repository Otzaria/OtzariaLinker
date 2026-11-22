import { describe, expect, it } from "vitest";
import { CITATION_GATE, citationGate, citationHintStrength } from "../../../../src/linking/automatic/citations";

/* Fix round, claim 11: a STRONG sign of a reference is a place and a number; a bare word of prose is not one (integration: tests/integration/workers/citations-gate-fixround.test.ts). */
const strong = (t: string, names?: (k: string) => boolean) => citationHintStrength(t, names) === "strong";

describe("citationHintStrength", () => {
  it.each(["כמו שנאמר בדף יג", "ראה פרק ב שם", "בסימן קכח", "סעיף ה", "הלכה ד", 'עיין ע"א', 'וכן בפ"ג', "פרק 12", "(סי׳ ב)", "ראה פסוק ג", "דף כג ע\"ב", "בפרקים ג"])("%s: strong", (t) => expect(strong(t)).toBe(true));

  it.each(["הלך האיש אל השוק ושם קנה", "ומשנה זו מבוארת", 'ראה ברש"י', "גמרא ומשנה", "פה ופי", "דף על", "פרק ראשון והשני", "הלכה למשה", "ראה סימן ועוד"])("%s: not strong (a word, a name or no number)", (t) => expect(strong(t)).toBe(false));

  it("weak is what the old gate accepted: a bare 'שם' is weak, and nothing is none", () => {
    expect(citationHintStrength("ושם נאמר")).toBe("weak");
    expect(citationHintStrength("הלך האיש אל השוק")).toBe("none");
  });

  it("a Hebrew word that adds up to a numeral is not a number unless it is written the one canonical way (על is a word; ק is 100)", () => {
    expect(strong("דף על")).toBe(false);
    expect(strong("דף ק")).toBe(true);
    expect(strong("סימן קכח")).toBe(true);
  });

  it("the name of an open book and a number is strong; the name alone is not", () => {
    const names = (k: string) => k === "בראשית";
    expect(strong("כמו שנאמר (בראשית א, א) ועוד", names)).toBe(true);
    expect(strong("כמו שנאמר בבראשית ברא אלהים", names)).toBe(false);
  });
});

describe("citationGate — when the book-level gate opens", () => {
  const lines = (g: ReturnType<typeof citationGate>, ts: readonly string[]) => ts.map((t) => g.add(t));
  it("one strong line opens it; a bare 'שם' or a place with no number, any number of times, does not", () => {
    expect(CITATION_GATE).toEqual({ strongLines: 1 });
    expect(lines(citationGate(), ["ושם", 'עיין ע"א', "ושם"])).toEqual([false, true, true]);
    const g = citationGate();
    for (let i = 0; i < 500; i++) expect(g.add(i % 2 ? "ושם נאמר" : "ראה בסימן ובסעיף שלמעלה")).toBe(false);
    expect(g.strong).toBe(0);
  });
  it("with the names of the open books: a name and two numbers opens it, a name and one number does not", () => {
    const names = (k: string) => k === "בראשית";
    expect(citationGate(names).add("כמו שנאמר (בראשית א, ב) ועוד")).toBe(true);
    expect(citationGate(names).add("כמו שנאמר בראשית א ועוד")).toBe(false);
  });
  it("lines with no sign count for nothing", () => {
    const g = citationGate();
    for (let i = 0; i < 500; i++) expect(g.add("הלך האיש אל השוק")).toBe(false);
    expect(g.strong).toBe(0);
  });
});
