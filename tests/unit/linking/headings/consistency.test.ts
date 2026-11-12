import { describe, expect, it } from "vitest";
import { toGematria } from "../../../../src/core/text/gematria";
import { headingLevel } from "../../../../src/core/text/html";
import { runHeadingsEngine } from "../../../../src/linking/automatic/headings";
import { QuoteChecker } from "../../../../src/linking/automatic/headings/quote";
import type { EngineBook } from "../../../../src/linking/automatic/types";

/*
 * The structural-consistency guards (src/linking/automatic/headings/consistency.ts, quote.ts), each on
 * a small book that reproduces a failure measured on the real database (REAL_DATA_REPORT.md §7).
 */
function book(key: string, title: string, lines: readonly string[]): EngineBook {
  return { book: { key, title, origin: "otzaria" }, lines: lines.map((text, index) => ({ index, text, heading: headingLevel(text), heRef: null })) };
}

const strong = (r: ReturnType<typeof runHeadingsEngine>) => r.suggestions.filter((s) => s.confidence === "certain" || s.confidence === "high");
const at = (r: ReturnType<typeof runHeadingsEngine>, line: number) => r.suggestions.find((s) => s.source.line === line)!;

/** sections "<h2>{name} {letter}</h2>", each with `<h3>סעיף n</h3>` + one content line for every n in `nums(section)` */
function sectioned(key: string, title: string, sections: readonly string[], nums: (s: number) => readonly number[]): EngineBook {
  const lines = [`<h1>${title}</h1>`];
  sections.forEach((name, s) => {
    lines.push(`<h2>${name}</h2>`);
    for (const n of nums(s)) lines.push(`<h3>סעיף ${toGematria(n)}</h3>`, `תוכן ${name} סעיף ${toGematria(n)} כאן`);
  });
  return book(key, title, lines);
}

const MAARACHOT = ["מערכת א", "מערכת ב", "מערכת ג", "מערכת ד"];
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("headings guard — the commentary's own numbering (הגהות מנחם ציון)", () => {
  // the base numbers its entries 1..20 in every section
  const base = sectioned("b:shem", "שם הגדולים", MAARACHOT, () => range(1, 20));

  it("numbers that run 1..k without gaps, section after section, far short of the base: never certain or high", () => {
    const notes = sectioned("c:hagahot", "הגהות", MAARACHOT, (s) => range(1, [6, 5, 7, 4][s]!));
    const r = runHeadingsEngine(notes, base);
    expect(r.notes.map((n) => n.code)).toContain("heading/own-numbering");
    expect(strong(r)).toEqual([]);
    expect(r.suggestions.length).toBeGreaterThan(0);
    for (const s of r.suggestions) {
      expect(s.confidence).toBe("possible");
      expect(s.rules).toContain("headings.numbering-suspect");
      expect(s.warnings.map((w) => w.code)).toContain("heading/own-numbering");
    }
  });

  it("a commentary that skips around the base's numbers keeps its certain links", () => {
    const sparse = sectioned("c:sparse", "פירוש", MAARACHOT, (s) => [[2, 5, 9, 14, 19], [1, 7, 12, 20], [3, 4, 11, 18], [6, 13, 17]][s]!);
    const r = runHeadingsEngine(sparse, base);
    expect(r.notes.map((n) => n.code)).not.toContain("heading/own-numbering");
    expect(r.suggestions.every((s) => s.confidence === "certain")).toBe(true);
  });

  it("a complete commentary (1..m in every section) keeps its certain links", () => {
    const full = sectioned("c:full", "פירוש", MAARACHOT, () => range(1, 20));
    const r = runHeadingsEngine(full, base);
    expect(r.suggestions.every((s) => s.confidence === "certain")).toBe(true);
  });

  it("one short section is not a pattern: a commentary on the first verses of one chapter stays certain", () => {
    const short = sectioned("c:short", "פירוש", ["מערכת א"], () => range(1, 4));
    const r = runHeadingsEngine(short, base);
    expect(r.suggestions.every((s) => s.confidence === "certain")).toBe(true);
  });
});

describe("headings guard — a level counting the commentary's own notes, past the base's numbers (ש\"ך על חושן משפט)", () => {
  const SIMANIM = ["סימן א", "סימן ב", "סימן ג", "סימן ד"];
  // the base has 5 סעיפים in each סימן; the ש"ך's "סעיף N" is its own ס"ק, up to 8
  const base = sectioned("b:sa", "שולחן ערוך", SIMANIM, () => range(1, 5));

  it("is detected; each line goes to its whole סימן, possible", () => {
    const shach = sectioned("c:shach", "שפתי כהן", SIMANIM, (s) => range(1, [8, 7, 3, 6][s]!));
    const r = runHeadingsEngine(shach, base);
    expect(r.notes.map((n) => n.code)).toContain("heading/beyond-base");
    expect(strong(r)).toEqual([]);
    // "סימן ב › סעיף ב" (commentary line 22): the whole סימן ב of the base (lines 14–22), not its סעיף ב (line 16)
    const s = at(r, 22);
    expect(s.target).toMatchObject({ line: 14, end: 22 });
    expect(s.confidence).toBe("possible");
    expect(s.warnings.map((w) => w.code)).toContain("heading/beyond-base");
  });

  it("a commentary on the base's own סעיפים (never past them) keeps its certain links", () => {
    const gra = sectioned("c:gra", "ביאור הגר\"א", SIMANIM, (s) => [[1, 3, 5], [2, 4], [1, 5], [3]][s]!);
    const r = runHeadingsEngine(gra, base);
    expect(r.notes.map((n) => n.code)).not.toContain("heading/beyond-base");
    expect(r.suggestions.every((s) => s.confidence === "certain")).toBe(true);
  });

  it("past the base in only two sections is not a pattern", () => {
    const two = sectioned("c:two", "פירוש", SIMANIM, (s) => range(1, [8, 7, 3, 4][s]!));
    expect(runHeadingsEngine(two, base).notes.map((n) => n.code)).not.toContain("heading/beyond-base");
  });
});

describe("headings guard — numbers the base does not have (ראב\"ד על ספרא)", () => {
  // the base's section numbers its 8 rules "(א)…(ח)"; the commentary counts its own paragraphs פסקה א…יב
  const base = book("b:sifra", "ספרא", [
    "<h1>ספרא</h1>",
    "<h2>ברייתא דרבי ישמעאל</h2>",
    "רבי ישמעאל אומר",
    ...range(1, 8).map((n) => `(${toGematria(n)}) מדה ${toGematria(n)} כיצד`),
    "<h2>ויקרא דבורא דנדבה</h2>",
    "<h3>פרק א</h3>",
    "ויקרא אל משה",
  ]);
  const raavad = book("c:raavad", 'ראב"ד על ספרא', [
    '<h1>ראב"ד על ספרא</h1>',
    "<h2>ברייתא דרבי ישמעאל</h2>",
    ...range(1, 12).flatMap((n) => [`<h3>פסקה ${toGematria(n)}</h3>`, `<b>דיבור ${toGematria(n)}.</b> פירוש`]),
  ]);

  it("is detected, and no line mapped onto the base's (N) lines is certain or high", () => {
    const r = runHeadingsEngine(raavad, base);
    expect(r.notes.map((n) => n.code)).toContain("heading/numbering-not-shared");
    expect(strong(r)).toEqual([]);
    const s = at(r, 3); // פסקה א
    expect(s.rules).toContain("headings.numbering-suspect");
    expect(s.confidence).toBe("possible");
  });
});

describe("headings guard — a line's place lies inside its section's place (מכילתא דרשב\"י)", () => {
  const base = book("b:mechilta", "מכילתא", [
    "<h1>מכילתא</h1>", // 0
    "<h2>פרק ג</h2>", //   1
    "ומשה היה רועה", //    2  the main פרק ג, not divided into verses
    "<h2>פרק ד</h2>", //   3
    "ויאמר משה", //        4
    "<h2>הוספה</h2>", //   5
    "<h3>פרק ג</h3>", //   6
    "(א) ויקרא אליו", //   7  an appendix that repeats פרק ג, verse by verse
    "(ב) ויאמר אל תקרב", // 8
  ]);
  const notes = book("c:notes", "הערות שוליים", ["<h1>הערות שוליים</h1>", "<h2>פרק ג</h2>", "<h3>פסוק א</h3>", "הערה על הפסוק", "<h2>פרק ד</h2>", "<h3>פסוק א</h3>", "הערה"]);

  it("a full match in another section loses to the partial match inside its own section", () => {
    const r = runHeadingsEngine(notes, base);
    const s = at(r, 3);
    expect(s.target).toMatchObject({ line: 2 });
    expect(s.confidence).toBe("possible"); // partial: the base's פרק ג has no verses
    expect(s.rules).toContain("headings.inside-section");
    expect(s.alternatives.map((a) => a.target.line)).not.toContain(7);
  });
});

describe("headings guard — the line's own quote (ביאור הגרא על תיקונים)", () => {
  // one base line per page; the commentary's page breaks fall a little later than the base's
  const base = book("b:tikkunim", "תיקונים", [
    "<h1>תיקונים</h1>", //                       0
    "<h2>א ע\"א</h2>", //                         1
    "פתח אליהו ואמר רבון עלמין", //               2
    "<h2>א ע\"ב</h2>", //                         3
    "אנת הוא חד ולא בחושבן", //                   4
    "<h2>א ע\"ג</h2>", //                         5
    "קם רבי שמעון ופתח", //                       6
  ]);
  const gra = book("c:gra", "ביאור הגרא", [
    "<h1>ביאור הגרא</h1>", //                    0
    "<h2>א ע\"א</h2>", //                         1
    "<b>פתח אליהו.</b> הוא הפתיחה", //            2  on its page: certain
    "<b>ולא בחושבן.</b> שאינו במספר", //          3  quotes the NEXT page
    "<b>כאן.</b> בלי ציטוט", //                   4  a quote not found anywhere: unchanged
    "פירוש בלי דיבור מתחיל", //                   5  no marked quote: unchanged
  ]);

  it("a quote found on the neighbouring page and not on the chosen one lowers the link to possible", () => {
    const r = runHeadingsEngine(gra, base);
    expect(at(r, 2).confidence).toBe("certain");
    const s = at(r, 3);
    expect(s.target).toMatchObject({ line: 2 }); // the structure's place is kept; only the confidence drops
    expect(s.confidence).toBe("possible");
    expect(s.rules).toContain("headings.quote-elsewhere");
    expect(s.warnings.find((w) => w.code === "heading/quote-elsewhere")!.text).toContain("שורה 5");
    expect(at(r, 4).confidence).toBe("certain");
    expect(at(r, 5).confidence).toBe("certain");
  });

  it("a quote that is on the chosen page confirms it even when a neighbour has it too", () => {
    const c = book("c:x", "פירוש", ["<h1>פירוש</h1>", "<h2>א ע\"ב</h2>", "<b>אנת הוא חד.</b> פירוש"]);
    const base2 = book("b:y", "בסיס", ["<h1>בסיס</h1>", "<h2>א ע\"א</h2>", "אנת הוא חד בעלמא", "<h2>א ע\"ב</h2>", "אנת הוא חד ולא בחושבן"]);
    expect(runHeadingsEngine(c, base2).suggestions[0]!.confidence).toBe("certain");
  });

  it("only a marked, specific quote is checked", () => {
    expect(QuoteChecker.phrase("<b>ולא בחושבן.</b> שאינו")).toBe(" ולא בחושבנ ");
    expect(QuoteChecker.phrase("ולא בחושבן שאינו במספר")).toBeNull(); // no boundary: not a marked quote
    expect(QuoteChecker.phrase("<b>כאן.</b> פירוש")).toBeNull(); // one word
    expect(QuoteChecker.phrase("<b>אמר לו.</b> פירוש")).toBeNull(); // only common words
  });
});
