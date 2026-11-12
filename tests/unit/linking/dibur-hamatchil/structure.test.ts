import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import { headingLevel } from "../../../../src/core/text/html";
import { headingWindowPlan, runDiburHamatchilEngine } from "../../../../src/linking/automatic/dibur-hamatchil";
import { baseMarkers, noteNumberOf, openingNoteNumbers } from "../../../../src/linking/automatic/dibur-hamatchil/markers";
import type { EngineBook, EngineResult, Suggestion } from "../../../../src/linking/automatic/types";

/*
 * Regressions of the two held-out pairs of REAL_DATA_REPORT.md §7.1 whose certain/high ד"ה
 * suggestions were mostly wrong, each reduced to a small synthetic book with the same structure:
 *   • "מקדש מלך" on the Zohar — the commentary's "כרך א" › "דף ה." matched only the volumes of the
 *     Zohar's appendix "תוספות", so every line was searched there;
 *   • R' Hartman's notes on נתיבות עולם — numbered notes that quote words from other places, while
 *     the base marks each note's place with <i data-commentator data-label>.
 */

const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria", isBaseBook: false });
const book = (r: BookRef, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });
const BASE = ref("txt:base", "ספר הבסיס");
const COMM = ref("txt:comm", "פירוש על ספר הבסיס");
const run = (comm: readonly string[], base: readonly string[]): EngineResult => runDiburHamatchilEngine(book(COMM, comm), book(BASE, base));
const commentaryLine = (s: Suggestion) => (s.source.book.key === COMM.key ? s.source.line : s.target.line);
const baseSide = (s: Suggestion) => (s.source.book.key === BASE.key ? s.source : s.target);
const byLine = (res: EngineResult, line: number) => res.suggestions.find((s) => commentaryLine(s) === line);

const filler = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `שורה של מילוי ${tag} מספר ${i} בלי שום דבר מיוחד`);

describe("heading windows that match only inside one unnamed minor section of the base", () => {
  // the Zohar: parsha sections, and "כרך א/ב" only as the volumes of a small appendix
  const ZOHAR = [
    "<h1>ספר הבסיס</h1>",
    "<h2>הקדמה</h2>",
    ...filler(12, "הקדמה"),
    "רבי שמעון פתח ואמר הנצנים נראו בארץ דא עובדא דבראשית", // 14
    ...filler(12, "הקדמה ב"),
    "<h2>בראשית</h2>",
    ...filler(10, "בראשית"),
    "תא חזי בשעתא דסליק ברעותא קמי מלכא למברי עלמא", // 38
    ...filler(10, "בראשית ב"),
    "<h2>תוספות</h2>",
    "<h3>כרך א</h3>",
    "שורה של התוספות על הנצנים בעלמא",
    "<h3>כרך ב</h3>",
    "שורה אחרת של התוספות",
  ];
  const MIKDASH = ["<h1>פירוש על ספר הבסיס</h1>", "<h2>כרך א</h2>", "<h3>דף ה.</h3>", "<b>הנצנים נראו בארץ</b> פירוש של המפרש", "<h3>דף ו.</h3>", "<b>בשעתא דסליק ברעותא</b> פירוש אחר"];

  it("are not used: the whole base is searched, by sequential progress, and the result says why", () => {
    const res = run(MIKDASH, ZOHAR);
    expect(baseSide(byLine(res, 3)!).line).toBe(14);
    expect(baseSide(byLine(res, 5)!).line).toBe(38);
    expect(byLine(res, 3)!.rules).toContain("dh/window-book");
    const note = res.notes.find((n) => n.code === "dh/headings-distrusted")!;
    expect(note.text).toContain('"תוספות"');
  });

  it("the plan names the section and the headings that matched in it", () => {
    const plan = headingWindowPlan(book(COMM, MIKDASH), book(BASE, ZOHAR));
    expect(plan.distrusted).toEqual({ section: "תוספות", matched: ["כרך א"] });
    expect(plan.windowOf(3).kind).toBe("book");
  });

  it("a commentary that names the section keeps its windows", () => {
    const named = ["<h1>פירוש על ספר הבסיס</h1>", "<h2>תוספות</h2>", "<h3>כרך א</h3>", "<b>על הנצנים</b> פירוש"];
    const plan = headingWindowPlan(book(COMM, named), book(BASE, ZOHAR));
    expect(plan.distrusted).toBeUndefined();
    expect(plan.windowOf(3)).toMatchObject({ kind: "heading", label: "כרך א" });
  });

  it("matches deeper than the commentary names, under DIFFERENT sections, are kept (סימן under each הלכות)", () => {
    const base = ["<h1>ספר הבסיס</h1>", "<h2>הלכות השכמה</h2>", "<h3>סימן א</h3>", ...filler(10, "א"), "<h2>הלכות לבישה</h2>", "<h3>סימן ב</h3>", ...filler(10, "ב")];
    const comm = ["<h1>פירוש</h1>", "<h2>סימן א</h2>", "פירוש", "<h2>סימן ב</h2>", "פירוש"];
    const plan = headingWindowPlan(book(COMM, comm), book(BASE, base));
    expect(plan.distrusted).toBeUndefined();
    expect(plan.windowOf(4)).toMatchObject({ kind: "heading", label: "סימן ב" });
  });

  it("a section that holds most of the base is the book itself: its windows are kept", () => {
    const base = ["<h1>ספר הבסיס</h1>", "<h2>הקדמה</h2>", "שורה", "<h2>גוף הספר</h2>", "<h3>פרק א</h3>", ...filler(10, "א"), "<h3>פרק ב</h3>", ...filler(10, "ב")];
    const comm = ["<h1>פירוש</h1>", "<h2>פרק א</h2>", "פירוש", "<h2>פרק ב</h2>", "פירוש"];
    expect(headingWindowPlan(book(COMM, comm), book(BASE, base)).distrusted).toBeUndefined();
  });
});

describe("numbered notes placed on the base's note markers", () => {
  const mark = (who: string, n: string | number) => `<i data-commentator="${who}" data-label="${n}"></i>`;
  const H = "Notes by Rabbi Yehoshua Hartman";
  // each base line carries the markers of the notes written on it
  const NETIVOT = [
    "<h1>ספר הבסיס</h1>",
    "<h2>פרק א</h2>",
    `<b>ויורני ויאמר</b> יתמוך דברי לבך${mark(H, 1)}, שלמה המלך רצה להזהיר את האדם על התורה${mark(H, 2)}.`,
    `<b>ומה שדברי</b> תורה תומכין כל העולם${mark(H, 3)}, דבר זה מדברי חכמים${mark(H, 4)}.`,
    `<b>ומפני שהתורה</b> היא סדר כל העולם${mark(H, 5)}, כל דבר שהוא מסודר הוא דבר אחד מקושר${mark(H, 6)}.`,
    `<b>ולכך אמר</b> כי התורה שהיא דברי השם יתברך תומכת האדם שלא יגיע לידי מיתה${mark(H, 7)}.`,
  ];
  const NOTES = [
    "<h1>פירוש על ספר הבסיס</h1>",
    "<h2>פרק א</h2>",
    "(1) מחבר ספר משלי.",
    '(2) "כי התורה שהיא דברי השם יתברך תומכת האדם שלא יגיע לידי מיתה" [לשונו להלן].',
    "(3) וכן כתב בהקדמה.",
    '(4) "כל דבר שהוא מסודר הוא דבר אחד מקושר" [לשונו בסמוך].',
    "(5) ראה לעיל.",
    "(6) וזהו יסוד נפוץ בספריו.",
    "(7) כמבואר בנתיב העבודה.",
  ];

  it("a note that quotes words from elsewhere is placed on its marker, certain, not where the words are", () => {
    const res = run(NOTES, NETIVOT);
    expect(NOTES.slice(2).map((_, k) => baseSide(byLine(res, k + 2)!).line)).toEqual([2, 2, 3, 3, 4, 4, 5]);
    const s = byLine(res, 3)!;
    expect(s.confidence).toBe("certain");
    expect(s.rules).toContain("dh/note-marker");
    expect(s.anchor).toBeUndefined(); // the marker is an empty element: nothing visible to anchor on
    expect(res.notes.find((n) => n.code === "dh/note-markers")!.text).toContain(H);
  });

  it("another commentator's markers are not used: far more markers than the notes have numbered lines", () => {
    // no Hartman markers; "Other Notes" numbers 1..16 — every note's number is there, but 16 markers for 7 notes
    let k = 0;
    const other = NETIVOT.map((l, i) => (i < 2 ? l : l.replace(/<i [^>]*><\/i>/g, "") + Array.from({ length: 4 }, () => mark("Other Notes", ++k)).join("")));
    const res = run(NOTES, other);
    expect(res.notes.map((n) => n.code)).not.toContain("dh/note-markers");
    expect(res.suggestions.some((s) => s.rules.includes("dh/note-marker"))).toBe(false);
  });

  it("restarting numbers without headings: the first marker at or after the previous note's place, as high", () => {
    const base = [`שורה ראשונה${mark(H, 1)} ועוד${mark(H, 2)}`, `שורה שניה${mark(H, 3)}`, `פרק אחר${mark(H, 1)}`, `ועוד שורה${mark(H, 2)}${mark(H, 3)}`];
    const notes = ["(1) א", "(2) ב", "(3) ג", "(1) ד", "(2) ה", "(3) ו"];
    const res = run(notes, base);
    expect(notes.map((_, k) => baseSide(byLine(res, k)!).line)).toEqual([0, 0, 1, 2, 3, 3]);
    expect(byLine(res, 3)!.confidence).toBe("high");
    expect(byLine(res, 3)!.rules).toContain("dh/note-marker-order");
  });

  it('a paragraph number before the note number ("(א) (טז)"): the marker in order is the note\'s', () => {
    const W = "Hagahot Sheerit Tzion";
    const base = [`ערך ראשון${mark(W, "א")}`, `ערך שני${mark(W, "ב")}`, `ערך שלישי${mark(W, "ג")}`, `ערך רביעי${mark(W, "ד")}`, `ערך חמישי${mark(W, "ה")}`, `ערך שישי${mark(W, "ו")}`];
    const notes = ["(א) הערה", "(ב) הערה", "(ג) הערה", "(א) (ד) הערה", "(ב) (ה) הערה", "(ג) (ו) הערה"];
    const res = run(notes, base);
    expect(notes.map((_, k) => baseSide(byLine(res, k)!).line)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe("markers.ts", () => {
  it("note numbers: digits and Hebrew letters; anything else is no number", () => {
    expect([noteNumberOf("12"), noteNumberOf("יב"), noteNumberOf("ט״ו"), noteNumberOf("⚬"), noteNumberOf("abc")]).toEqual([12, 12, 15, null, null]);
    expect(openingNoteNumbers("(17) כי המשפט")).toEqual([17]);
    expect(openingNoteNumbers("<b>[יב]</b> פירוש")).toEqual([12]);
    expect(openingNoteNumbers("(א) (טז) הגהות")).toEqual([1, 16]);
    expect(openingNoteNumbers("פירוש (א) באמצע")).toEqual([]);
  });

  it("base markers by commentator and number; unnumbered markers (data-order only, ⚬) are skipped", () => {
    const lines = [
      { index: 0, text: 'א<i data-commentator="X" data-label="א" data-order="1"></i>ב<i data-commentator="Y" data-order="2"></i>', heading: null },
      { index: 1, text: '<i data-label="2" data-commentator="X"></i><i data-commentator="X" data-label="⚬"></i>', heading: null },
    ];
    expect(baseMarkers(lines).map((m) => [m.commentator, [...m.byNumber]])).toEqual([["X", [[1, [0]], [2, [1]]]]]);
  });
});
