import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import { headingLevel } from "../../../../src/core/text/html";
import { extractDh, runDiburHamatchilEngine, type DhOptions } from "../../../../src/linking/automatic/dibur-hamatchil";
import { commentatorOfTitle } from "../../../../src/linking/automatic/dibur-hamatchil/addressee";
import { monotoneChain } from "../../../../src/linking/automatic/dibur-hamatchil/engine";
import type { EngineBook, EngineResult, Suggestion } from "../../../../src/linking/automatic/types";

/*
 * The owner's requirements for a ד"ה linker (otzaria-library docs/דרישות-סקריפט-התאמת-דיבור-המתחיל.md),
 * one small synthetic book per rule, with the negatives that must NOT link.
 */
const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria", isBaseBook: false });
const book = (r: BookRef, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });
const GEMARA = ref("txt:base", "מועד קטן");
const TOSAFOT = ref("txt:base", "תוספות על מועד קטן");
const COMM = ref("txt:comm", "קרן אורה על מועד קטן");
const run = (comm: readonly string[], base: readonly string[], baseRef: BookRef = GEMARA, opts: DhOptions = {}): EngineResult =>
  runDiburHamatchilEngine(book(COMM, comm), book(baseRef, base), opts);
const commentaryLine = (s: Suggestion) => (s.source.book.key === COMM.key ? s.source.line : s.target.line);
const baseSide = (s: Suggestion) => (s.source.book.key === COMM.key ? s.target : s.source);
const byLine = (res: EngineResult, line: number) => res.suggestions.find((s) => commentaryLine(s) === line);
const why = (res: EngineResult, line: number) => res.unmatched.find((u) => u.line === line)?.reasons.map((r) => r.code) ?? [];

const DAF = [
  "<h1>מועד קטן</h1>",
  "<h2>דף ב.</h2>",
  "משקין בית השלחין במועד ובשביעית בין ממעין שיצא לכתחלה",
  "אבל אין משקין לא ממי הגשמים ולא ממי הקילון ואין עושין עוגיות לגפנים",
  "וצריך לעצים חייב שתים משום זורע ומשום חורש",
  "אמר רב הונא דברים שבין אדם לחבירו מותר לעשותן",
];
const TOS = [
  "<h1>תוספות על מועד קטן</h1>",
  "<h2>דף ב.</h2>",
  "<b>משקין בית השלחין</b> – פירוש שדה הצמאה",
  "<b>ואין עושין עוגיות</b> – גומות סביב הגפנים",
  "<b>וצריך לעצים</b> – אבל אם אין צריך לעצים לא",
  "<b>חייב שתים</b> – משום זורע ומשום חורש",
];

describe("§2 intermediate commentators: a line on רש\"י/תוספות belongs to their book, not to the Gemara", () => {
  const comm = [
    "<h1>קרן אורה</h1>",
    "<h2>דף ב.</h2>",
    "<b>גמרא</b> משקין בית השלחין כו' הנה באיסור",
    "<b>שם תוס'</b> בד\"ה וצריך לעצים עיין בדבריהם",
    "<b>שם בא\"ד</b> ועוד כתבו שם",
    "<b>שם גמרא</b> ואין עושין עוגיות כו' פירוש",
  ];

  it("with the Gemara as base: the Tosafot line and its בא\"ד are skipped; the Gemara lines are linked", () => {
    const res = run(comm, DAF);
    expect(baseSide(byLine(res, 2)!).line).toBe(2);
    expect(why(res, 3)).toEqual(["dh/intermediate"]);
    expect(why(res, 4)).toEqual(["dh/intermediate"]);
    expect(baseSide(byLine(res, 5)!).line).toBe(3);
  });

  it("with תוספות as base: the Tosafot line finds its lemma; the Gemara lines are skipped", () => {
    expect(commentatorOfTitle(TOSAFOT.title)?.key).toBe("tosafot");
    const res = run(comm, TOS, TOSAFOT);
    expect(baseSide(byLine(res, 3)!).line).toBe(4);
    expect(baseSide(byLine(res, 4)!).line).toBe(4); // בא"ד: the same lemma
    expect(why(res, 2)).toEqual(["dh/not-intermediate"]);
  });

  it("negative: a commentator's NAME quoted as the ד\"ה itself (\"<b>וברמב\"ן:</b>\") is a quote, not a label", () => {
    const e = extractDh('<b>וברמב"ן:</b> על גיליון בת"א דפוס ראשון');
    expect(e.addressee).toBeNull();
    expect(e.dh.map((t) => t.key)).toEqual(["וברמבנ"]);
  });

  it("negative: \"תוספות הרא\"ש על נדה\" is not תוספות; a title without \" על \" is no commentator", () => {
    expect(commentatorOfTitle('תוספות הרא"ש על מסכת נדה')).toBeNull();
    expect(commentatorOfTitle('רש"י')).toBeNull();
    expect(commentatorOfTitle('רש"י על בראשית')?.key).toBe("rashi");
  });

  it("addressedOnly (the planner's step to another commentator): a line that names no one is not searched in the commentator", () => {
    // a ד"ה that names nobody, quoting words תוספות also quote: without the option it would match there
    const plain = ["<h1>קרן אורה</h1>", "<h2>דף ב.</h2>", "<b>וצריך לעצים</b> חייב שתים כו' הנה", "<b>שם תוס'</b> בד\"ה וצריך לעצים עיין בדבריהם"];
    expect(byLine(run(plain, TOS, TOSAFOT), 2)).toBeDefined();
    const res = run(plain, TOS, TOSAFOT, { addressedOnly: true });
    expect(byLine(res, 2)).toBeUndefined();
    expect(why(res, 2)).toEqual(["dh/not-addressed"]);
    expect(baseSide(byLine(res, 3)!).line).toBe(4);
  });

  it("the option `intermediates: false` links every line to the base, as before", () => {
    const res = run(comm, DAF, GEMARA, { intermediates: false });
    expect(why(res, 3)).not.toContain("dh/intermediate");
  });
});

describe("§3 continuation lines with no anchor of their own", () => {
  it("a bold opener label (\"<b>שוב</b> ראיתי\", \"עוד כתב\") takes the previous line's place", () => {
    const res = run(["<h2>דף ב.</h2>", "<b>משקין בית השלחין.</b> פירוש", "<b>שוב</b> ראיתי בירושלמי"], DAF);
    expect(byLine(res, 2)!.rules).toContain("dh/inherit-opener");
    expect(baseSide(byLine(res, 2)!).line).toBe(2);
    const res2 = run(["<h2>דף ב.</h2>", "<b>משקין בית השלחין.</b> פירוש", "עוד כתב שם דבר אחר"], DAF);
    expect(byLine(res2, 2)!.rules).toContain("dh/inherit-opener");
    // each hop weakens the claim: a chain of continuations ends (dh/inherit-weak)
    expect(why(run(["<h2>דף ב.</h2>", "<b>משקין בית השלחין.</b> פירוש", "<b>שוב</b> ראיתי", "עוד כתב שם"], DAF), 3)).toEqual(["dh/inherit-weak"]);
  });

  it("a new bold quote right after the label is searched on its own", () => {
    const res = run(["<h2>דף ב.</h2>", "<b>משקין בית השלחין.</b> פירוש", "<b>עוד</b> <b>ואין עושין עוגיות.</b> פירוש"], DAF);
    expect(baseSide(byLine(res, 2)!).line).toBe(3);
    expect(byLine(res, 2)!.rules).not.toContain("dh/inherit-opener");
  });

  it("§8 negative: no continuation crosses a heading (בא\"ד, שם, an opener)", () => {
    const base = [...DAF, "<h2>דף ב:</h2>", "שורה אחרת בעמוד השני"];
    const res = run(["<h2>דף ב.</h2>", "<b>משקין בית השלחין.</b> פירוש", "<h2>דף ב:</h2>", "<b>בא\"ד</b> ועוד", "<b>שוב</b> ראיתי"], base);
    expect(why(res, 3)).toEqual(["dh/no-parent"]);
    expect(why(res, 4)).toEqual(["dh/no-parent"]);
  });
});

describe("§15 attribution before the quote", () => {
  it("\"אר\"ה כו' X\": the quote is X", () => {
    const e = extractDh("אר\"ה כו' דברים שבין אדם לחבירו. פירוש");
    expect(e.attribution).toBe('אר"ה');
    expect(e.dh.map((t) => t.key)).toEqual(["דברימ", "שבינ", "אדמ", "לחבירו"]);
  });

  it("negative: an attribution that IS the quote's start stays (no כו' after it)", () => {
    expect(extractDh("<b>א\"ר יוחנן משום רבי</b> פירוש").attribution).toBeNull();
  });
});

describe("§7 \"ד\"ה X … עד ד\"ה Y\": a range", () => {
  const comm = ["<h2>דף ב.</h2>", "<b>תוס'</b> ד\"ה וצריך לעצים עד ד\"ה חייב שתים כו' ועיין בדבריהם"];

  it("the extracted ד\"ה stops before עד, and Y is the range end", () => {
    const e = extractDh(comm[1]!);
    expect(e.dh.map((t) => t.key)).toEqual(["וצריכ", "לעצימ"]);
    expect(e.range.map((t) => t.key)).toEqual(["חייב", "שתימ"]);
  });

  it("both ends are found: the target is the range of lemmas", () => {
    const s = byLine(run(comm, TOS, TOSAFOT), 1)!;
    expect(baseSide(s)).toMatchObject({ line: 4, end: 5 });
    expect(s.rules).toContain("dh/range");
  });

  it("negative: an end that is not there gives the start only, with a warning", () => {
    const s = byLine(run(["<h2>דף ב.</h2>", "<b>תוס'</b> ד\"ה וצריך לעצים עד ד\"ה שבת הגדול כו' ועיין"], TOS, TOSAFOT), 1)!;
    expect(baseSide(s).end).toBeUndefined();
    expect(s.warnings.map((w) => w.code)).toContain("dh/range-unresolved");
  });
});

describe("§9 front matter and colophons", () => {
  it("an author line before the first heading and a colophon are skipped, not searched", () => {
    const res = run(["<h1>קרן אורה</h1>", "רבי יצחק מינקובסקי", "<h2>דף ב.</h2>", "<b>משקין בית השלחין.</b> פירוש", "<b>סליק</b> מסכת מועד קטן"], DAF);
    expect(why(res, 1)).toEqual(["dh/front-matter"]);
    expect(why(res, 4)).toEqual(["dh/colophon"]);
  });
});

describe("item paragraphs: plain paragraphs after a bold ד\"ה belong to its place", () => {
  const base = ["<h1>בסיס</h1>", "<h3>סימן א</h3>", "<h4>סעיף א</h4>", "יתגבר כארי לעמוד בבוקר לעבודת בוראו", "<h4>סעיף ב</h4>", "המשכים להתחנן לפני בוראו יכוין לשעות"];
  const comm = ["<h1>פירוש</h1>", "<h3>סימן א</h3>", "<h4>סעיף ב</h4>", "<h5>ס\"ק א</h5>", "<b>המשכים להתחנן.</b> צריך להאריך", "עוד יש להביא ראיה מיבמות", "זאת שנית מראש השנה"];

  it("are linked to the ד\"ה's place (dh/inherit-item)", () => {
    const res = run(comm, base);
    for (const l of [5, 6]) {
      expect(baseSide(byLine(res, l)!).line).toBe(5);
      expect(byLine(res, l)!.rules).toContain("dh/inherit-item");
    }
  });

  it("negative: not across a heading, and not with `continueItems: false`", () => {
    const res = run([...comm.slice(0, 5), "<h5>ס\"ק ב</h5>", "עוד יש להביא ראיה מיבמות"], base);
    expect(byLine(res, 6)).toBeUndefined();
    expect(byLine(run(comm, base, GEMARA, { continueItems: false }), 5)).toBeUndefined();
  });

  it("negative: not in a book whose sections hold many bold ד\"ה lines (every line has its own)", () => {
    const many = ["<h1>פירוש</h1>", "<h3>סימן א</h3>", ...Array.from({ length: 5 }, () => "<b>המשכים להתחנן.</b> פירוש"), "עוד יש להביא ראיה מיבמות"];
    expect(byLine(run(many, base), 7)).toBeUndefined();
  });
});

describe("the order of the whole commentary", () => {
  it("monotoneChain: the heaviest non-decreasing chain of base lines", () => {
    const items = [
      { cLine: 0, base: 1, score: 0.9 },
      { cLine: 1, base: 9, score: 0.6 }, // off: lines before and after go elsewhere
      { cLine: 2, base: 2, score: 0.9 },
      { cLine: 3, base: 3, score: 0.9 },
    ];
    expect([...monotoneChain(items)].sort()).toEqual([0, 2, 3]);
  });

  it("a placement off the order of its neighbours is dropped (dh/off-order); with `order: false` it stays", () => {
    const base = ["אחד שורה ראשונה", "ויקח אהרן את המחתה", "שורה שלישית סתם", "ויאמר משה אל העם", "שורה חמישית סתם", "ויבא משה ואהרן", "וישמע פרעה את הדבר"];
    const comm = ["<b>ויקח אהרן.</b> פי׳", "<b>ויאמר משה אל העם.</b> פי׳", "<b>אחד שורה ראשונה.</b> פי׳", "<b>ויבא משה ואהרן.</b> פי׳", "<b>וישמע פרעה.</b> פי׳"];
    const res = run(comm, base);
    expect(byLine(res, 2)).toBeUndefined();
    expect(why(res, 2)).toContain("dh/off-order");
    expect(byLine(res, 3)).toBeDefined();
    expect(byLine(run(comm, base, GEMARA, { order: false }), 2)).toBeDefined();
  });
});

describe("bold only on the first word, a seif label, a lemma-head base", () => {
  it("\"<b>אפי' </b>נשים.\": the ד\"ה runs to the period", () => {
    const e = extractDh("<b>אפי' </b>נשים. עי' באשל אברהם");
    expect(e.dh.map((t) => t.key)).toEqual(["אפי"]);
    expect(e.extended.map((t) => t.key)).toEqual(["אפי", "נשימ"]);
    const res = run(["<b>אפי' </b>נשים. עי' באשל אברהם"], ["הכל שוחטין אפילו כותים", "אפילו נשים שוחטות לכתחלה"]);
    expect(baseSide(res.suggestions[0]!).line).toBe(1);
    expect(res.suggestions[0]!.rules).toContain("dh/extended");
  });

  it("\"(סעיף ב')\" before the quote: only that seif of the siman is searched", () => {
    const base = ["<h1>שולחן ערוך</h1>", "<h2>סימן א</h2>", "(א) יתגבר כארי לעמוד וטוב לומר", "(ב) המשכים להתחנן וטוב לומר פרשת העקידה"];
    const e = extractDh("<b>(סעיף ב')  </b>וטוב לומר וכו'. נ\"ב הנה");
    expect(e.unit).toEqual({ kind: "סעיף", n: 2 });
    expect(e.dh.map((t) => t.key)).toEqual(["וטוב", "לומר"]);
    const s = run(["<h1>פירוש</h1>", "<h2>סימן א</h2>", "<b>(סעיף ב')  </b>וטוב לומר וכו'. נ\"ב הנה"], base).suggestions[0]!;
    expect(baseSide(s).line).toBe(3);
    expect(s.rules).toContain("dh/unit-label");
  });

  it("a base whose lines open with their own lemma: matching that lemma is strong evidence", () => {
    const s = byLine(run(["<h2>דף ב.</h2>", "<b>תוס'</b> בד\"ה ואין עושין עוגיות עיין בדבריהם שכתבו"], TOS, TOSAFOT), 1)!;
    expect(baseSide(s).line).toBe(3);
    expect(s.rules).toContain("dh/lemma-head");
    expect(["certain", "high"]).toContain(s.confidence);
  });
});

describe("§6 fuzzy: the letters of the ד\"ה by edit distance (rung L)", () => {
  const base = ["<h2>דף ב.</h2>", "אמר רבא שרי לרפויי ארעא במועד דלא טרח", "שורה אחרת על דבר אחר לגמרי בלי קשר", "ועוד שורה שלישית בלי שום קשר לכאן"];

  it("a quote whose words drifted beyond a word step is found, with the rung said", () => {
    // "שריא למרפוי ארעאה": a different prefix, a dropped yod and an added he, in a ד\"ה of three words
    const res = run(["<h2>דף ב.</h2>", "<b>שריא למרפוי ארעאה.</b> פירוש"], base);
    const s = res.suggestions[0]!;
    expect(baseSide(s).line).toBe(1);
    expect(s.rules).toContain("dh/rung-L");
    expect(s.confidence).not.toBe("certain");
  });

  it("negative: letters that are not there are not found", () => {
    const res = run(["<h2>דף ב.</h2>", "<b>כבשין שהוא יכול לאכול.</b> פירוש"], base);
    expect(res.suggestions).toEqual([]);
  });
});
