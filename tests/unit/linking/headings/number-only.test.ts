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
  it('נועם אלימלך (id 400, lines 360–363): "וישלח › פירוש ב" is its own second piece on the parasha, not verse ב of every chapter', () => {
    const noam = book("c:noam", "נועם אלימלך", [
      "<h1>נועם אלימלך</h1>",
      "<h2>ספר בראשית</h2>",
      "<h3>וישלח</h3>",
      "<h4>פירוש ב</h4>",
      '<b>או יאמר</b> "ויהי לי שור וחמור" דהנה כתיב "ויאמר אלקים ישרצו המים שרץ נפש חיה ועוף יעופף על הארץ".',
      `"ויירא יעקב כו' ויצר לו", דהנה הצדיק השלם העובד ה' בתמימות בכל לבו אין כל אומה ולשון יכולים לשלוט בו להרע לו ח"ו`,
    ]);
    const r = runHeadingsEngine(noam, chapters("b:gen0", "בראשית", [[1, 31], [2, 25], [32, 33]]));
    expect(r.suggestions).toEqual([]);
    expect(codes(r, 4)).toEqual(["heading/number-only"]);
    expect(codes(r, 5)).toEqual(["heading/number-only"]);
    expect(r.unmatched.find((u) => u.line === 5)!.reasons[0]!.text).toContain('רק המספר ב של "ספר בראשית, וישלח, פירוש ב" נמצא בספר הבסיס, ב־3 מקומות שאין ביניהם הבדל אחר (פרק א, ב; פרק ב, ב; פרק לב, ב)');
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

  it("one place left is still a number alone: the same lines against a base with one verse מג are suggested, never above possible", () => {
    // before: "high" (0.93) — מדרש תהילים "מזמור קלו" → תהילים קיט, קלו was 342 of 343 such highs wrong against the library
    const r = runHeadingsEngine(sifre("c:sifre1"), chapters("b:deut1", "דברים", [[1, 46], [2, 37]]));
    expect(r.suggestions.map((s) => s.source.line)).toEqual([2, 3]);
    for (const s of r.suggestions) {
      expect(s.confidence).toBe("possible");
      expect(s.warnings.map((w) => w.code)).toContain("heading/number-only");
      expect(s.rules).toContain("headings.number-only");
    }
  });

  it('מלבי"ם על ויקרא (id 3396, lines 3508–3509): an order tiebreak among bare numbers is a number alone too', () => {
    // the line before is placed for certain (a named section both books have); "בהר › סימן נה" (the Malbim's own
    // running סימן) then tied verse נה of פרקים יג, יד, כה, and the book's order chose יג — "high" (0.9) before, wrong
    const malbim = book("c:malbim", 'מלבי"ם על ויקרא', [
      '<h1>מלבי"ם על ויקרא</h1>',
      "<h2>הקדמה</h2>",
      "דברי פתיחה לספר",
      "<h2>בהר</h2>",
      "<h3>סימן נה</h3>",
      'עד מלאת לו שנה תמימה: מלת "לו" מוסב על שם "ואיש" הנזכר בראש הפרשה, שהוא המוכר, או על שם "ממכרו" שנזכר בסמוך ר"ל להמכר.',
    ]);
    const lev = chapters("b:lev", "ויקרא", [[13, 59], [14, 57], [25, 55]]);
    const r = runHeadingsEngine(malbim, book("b:lev", "ויקרא", [lev.lines[0]!.text, "<h2>הקדמה</h2>", "פתיחה", ...lev.lines.slice(1).map((l) => l.text)]));
    expect(r.suggestions.find((s) => s.source.line === 2)!.confidence).toBe("certain");
    const s = r.suggestions.find((x) => x.source.line === 5)!;
    expect(s.rules).toContain("headings.order-tiebreak");
    expect(s.confidence).toBe("possible");
    expect(s.warnings.map((w) => w.code)).toContain("heading/number-only");
  });

  it('מדרש תהילים (id 267, lines 362–363): "מזמור ל" is פרק ל of תהילים, the whole chapter', () => {
    const midrash = book("c:mt2", "מדרש תהילים", [
      "<h1>מדרש תהילים</h1>",
      "<h2>מזמור ל</h2>",
      "מזמור שיר חנוכת הבית לדוד. אמר רב חסדא לית מילתא פליגא שבית המקדש של מטה מכוון כנגד בית המקדש של מעלה.",
    ]);
    // פרק ל has 13 verses; פרק לד has a verse ל — before, "מזמור ל" could only reach that bare "(ל)"
    const base = chapters("b:ps2", "תהילים", [[22, 32], [30, 13], [34, 23]]);
    const s = runHeadingsEngine(midrash, base).suggestions[0]!;
    const start = base.lines.findIndex((l) => l.text === "<h2>פרק ל</h2>") + 1;
    expect(s.target).toMatchObject({ line: start, end: start + 12 });
    expect(s.confidence).toBe("high");
    expect(s.reasons.map((x) => x.text)).toContain('"מזמור ל" הוא "פרק ל" בספר הבסיס (מזמור ופרק הם אותה יחידה)');
  });

  it('באר הגולה על אבן העזר (id 3847, line 363): "סימן יב" goes to סימן יב, not to the "(יב)" lines of the appended סדר הגט', () => {
    const base = book("b:eh", "שולחן ערוך, אבן העזר", [
      "<h1>שולחן ערוך, אבן העזר</h1>",
      "<h2>סימן יא</h2>",
      "(א) סעיף",
      "<h2>סימן יב</h2>",
      "(א) סעיף א",
      "(ב) סעיף ב",
      "<h2>סדר הגט</h2>",
      ...Array.from({ length: 12 }, (_, i) => `(${toGematria(i + 1)}) סדר הגט ${i + 1}`),
      "<h2>סדר חליצה</h2>",
      ...Array.from({ length: 12 }, (_, i) => `(${toGematria(i + 1)}) סדר חליצה ${i + 1}`),
    ]);
    const beer = book("c:beer", "באר הגולה על שולחן ערוך אבן העזר", ["<h1>באר הגולה</h1>", "<h2>סימן יב</h2>", "(ז) שם במשנה"]);
    const s = runHeadingsEngine(beer, base).suggestions[0]!;
    // before: "ambiguous", best = סדר הגט (יב) at 0.93 over the range of סימן יב at 0.92
    expect(s.target).toMatchObject({ line: 4, end: 5 });
    expect(s.confidence).toBe("possible");
    expect(s.rules).toContain("headings.bare-number-rival");
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
