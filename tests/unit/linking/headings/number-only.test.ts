import { describe, expect, it } from "vitest";
import { toGematria } from "../../../../src/core/text/gematria";
import { headingLevel } from "../../../../src/core/text/html";
import { runHeadingsEngine } from "../../../../src/linking/automatic/headings";
import type { EngineBook } from "../../../../src/linking/automatic/types";

/*
 * "Number only" (src/linking/automatic/headings/index.ts): a tie in which every candidate is placed by one
 * number of the line's path and nothing else is not a suggestion. The commentary lines are real lines of
 * the Otzaria database (seforim.db, 2026-11-16; book id and line index in each test); the bases are cut
 * down to the chapters that make the tie, with the real heading shape ("<h2>פרק N</h2>", "(N) …" lines).
 * Measured: AUTOMATION_ENGINE.md §2, "מספר בלבד".
 */
function book(key: string, title: string, lines: readonly string[]): EngineBook {
  return { book: { key, title, origin: "otzaria" }, lines: lines.map((text, index) => ({ index, text, heading: headingLevel(text), heRef: null })) };
}

/** a base with "<h2>פרק N</h2>" and "(v) …" verse lines, for the given [chapter, verses] */
function chapters(key: string, title: string, list: readonly (readonly [number, number])[]): EngineBook {
  const lines = [`<h1>${title}</h1>`];
  for (const [ch, verses] of list) {
    lines.push(`<h2>פרק ${toGematria(ch)}</h2>`);
    for (let v = 1; v <= verses; v++) lines.push(`(${toGematria(v)}) פסוק ${toGematria(v)} של פרק ${toGematria(ch)}`);
  }
  return book(key, title, lines);
}

const codes = (r: ReturnType<typeof runHeadingsEngine>, line: number) => r.unmatched.find((u) => u.line === line)?.reasons.map((x) => x.code) ?? [];

describe("headings — a tie on a number alone is not a suggestion", () => {
  it('מדרש תהילים (id 267, lines 360–363): "מזמור ל" is not verse ל of every chapter that has one', () => {
    const midrash = book("c:mt", "מדרש תהילים", [
      "<h1>מדרש תהילים</h1>",
      "<h2>מזמור כט</h2>",
      "מזמור לדוד הבו לה' בני אלים. זה שאמר הכתוב על ידי יחזקאל (יחזקאל לד כב) והושעתי לצאני ולא תהיינה עוד לבז.",
      "<h2>מזמור ל</h2>",
      "מזמור שיר חנוכת הבית לדוד. אמר רב חסדא לית מילתא פליגא שבית המקדש של מטה מכוון כנגד בית המקדש של מעלה.",
    ]);
    // תהילים יח (51 verses) and כב (32) both have a verse ל and a verse כט; פרק ל of the base is not in this cut
    const r = runHeadingsEngine(midrash, chapters("b:ps", "תהילים", [[1, 6], [18, 51], [22, 32]]));
    expect(r.suggestions).toEqual([]);
    expect(codes(r, 2)).toEqual(["heading/number-only"]);
    expect(codes(r, 4)).toEqual(["heading/number-only"]);
    expect(r.unmatched.find((u) => u.line === 4)!.reasons[0]!.text).toContain("רק המספר ל של \"מזמור ל\" נמצא בספר הבסיס, ב־2 מקומות שאין ביניהם הבדל אחר (פרק יח, ל; פרק כב, ל)");
    expect(r.notes.find((n) => n.code === "heading/number-only")?.text).toMatch(/^2 שורות/);
  });

  it("שפת אמת (id 441, lines 0–8): the year sections \"חלק א\" under a parasha name are its own count, not verse א", () => {
    const sfas = book("c:sfas", "שפת אמת", [
      "<h1>שפת אמת</h1>",
      "רבי יהודה אריה ליב אלתר",
      "<h2>בראשית</h2>",
      "<h3>בראשית</h3>",
      "<h4>חלק א</h4>",
      '<b>תרל"א</b>',
      'ב"ה',
      "ברש\"י ז\"ל מה הי' עולם חסר מנוחה בא שבת בא מנוחה כלתה ונגמרה המלאכה. כי בריאת העולם היה להשפיע אור וטובו של השי\"ת בעוה\"ז",
      "ברש\"י א\"ר יצחק לא הי' צריך להתחיל התורה אלא מהחודש הזה מצוה ראשונה אלא כח מעשיו הגיד כו'. ויש להבין מה התירוץ על כל הפרשה",
    ]);
    const r = runHeadingsEngine(sfas, chapters("b:gen", "בראשית", [[1, 31], [2, 25], [3, 24]]));
    expect(r.suggestions).toEqual([]);
    for (const line of [5, 6, 7, 8]) expect(codes(r, line)).toEqual(["heading/number-only"]);
  });

  const sifre = (key: string) =>
    book(key, "ספרי דברים", [
      "<h1>ספרי דברים</h1>",
      "<h2>פסקה מג</h2>",
      "אִם עֲשִׂיתֶם כֵּן (דברים יא יז) <b>וְחָרָה אַף ה׳ בָּכֶם</b>. מָשָׁל לְמֶלֶךְ שֶׁשִּׁגֵּר אֶת בְּנוֹ לְבֵית הַמִּשְׁתֶּה",
      "<b>וְחָרָה אַף ה׳ בָּכֶם</b>, שׁוֹמֵעַ אֲנִי שֶׁהֵם כָּלִים מִן הָעוֹלָם? תַּלְמוּד לוֹמַר: ״וְעָצַר אֶת הַשָּׁמַיִם״",
    ]);

  it('ספרי דברים (id 290, lines 362–363): "פסקה מג" is the Sifre\'s own paragraph, not verse מג of דברים א and ד', () => {
    const r = runHeadingsEngine(sifre("c:sifre"), chapters("b:deut", "דברים", [[1, 46], [4, 49]]));
    expect(r.suggestions).toEqual([]);
    expect(codes(r, 2)).toEqual(["heading/number-only"]);
    expect(codes(r, 3)).toEqual(["heading/number-only"]);
  });

  it("one place is not a tie: the same lines against a base with one verse מג still get a suggestion (not changed here)", () => {
    const r = runHeadingsEngine(sifre("c:sifre1"), chapters("b:deut1", "דברים", [[1, 46], [2, 37]]));
    expect(r.suggestions.map((s) => s.source.line)).toEqual([2, 3]);
    expect(r.notes.map((n) => n.code)).not.toContain("heading/number-only");
  });

  it("a tie that also matches a chapter stays a choice for the reviewer (ambiguous), not number-only", () => {
    // the base has פרק א twice (two editions bound together); "פרק א › פסוק ב" matches both on two numbers
    const base = book("b:twice", "בסיס", ["<h1>בסיס</h1>", "<h2>חלק ראשון</h2>", "<h3>פרק א</h3>", "(א) א", "(ב) ב", "<h2>חלק שני</h2>", "<h3>פרק א</h3>", "(א) א", "(ב) ב"]);
    const c = book("c:twice", "פירוש", ["<h1>פירוש</h1>", "<h2>פרק א</h2>", "<h3>פסוק ב</h3>", "פירוש על פסוק ב"]);
    const r = runHeadingsEngine(c, base);
    expect(r.suggestions.find((s) => s.source.line === 3)!.confidence).toBe("ambiguous");
    expect(r.notes.map((n) => n.code)).not.toContain("heading/number-only");
  });
});
