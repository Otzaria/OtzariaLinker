import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import { headingLevel } from "../../../../src/core/text/html";
import { headingWindowPlan, runDiburHamatchilEngine } from "../../../../src/linking/automatic/dibur-hamatchil";
import { headingKey, headingNumber } from "../../../../src/linking/automatic/dibur-hamatchil/windows";
import type { EngineBook, EngineResult, Suggestion } from "../../../../src/linking/automatic/types";

/*
 * Scopes from whatever hierarchy both books share (windows.ts): numbered headings by kind and number
 * in any spelling, daf headings in any notation, lines the base numbers itself ("פסוק ג" ↔ "(ג)"),
 * and inline page markers (the Zohar's Vilna pages) for a base with no daf headings.
 */
const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria", isBaseBook: false });
const book = (r: BookRef, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });
const BASE = ref("txt:base", "ספר הבסיס");
const COMM = ref("txt:comm", "פירוש על ספר הבסיס");
const run = (comm: readonly string[], base: readonly string[]): EngineResult => runDiburHamatchilEngine(book(COMM, comm), book(BASE, base));
const commentaryLine = (s: Suggestion) => (s.source.book.key === COMM.key ? s.source.line : s.target.line);
const baseSide = (s: Suggestion) => (s.source.book.key === BASE.key ? s.source : s.target);
const byLine = (res: EngineResult, line: number) => res.suggestions.find((s) => commentaryLine(s) === line);
const plan = (comm: readonly string[], base: readonly string[]) => headingWindowPlan(book(COMM, comm), book(BASE, base));

describe("headingKey: what a heading names", () => {
  it("a numbered heading is its kind and number, in any spelling", () => {
    expect(headingKey("<h3>סימן י\"ב</h3>").key).toBe("סימן:12");
    expect(headingKey("<h3>סימן יב</h3>").key).toBe("סימן:12");
    expect(headingKey("<h3>סימן יב - דין הנהגת אדם בבוקר</h3>").key).toBe("סימן:12");
    expect(headingKey("<h5>ס\"ק ג</h5>").key).toBe(headingKey("<h5>סעיף קטן ג</h5>").key);
    expect(headingKey("<h3>סי' טו</h3>").key).toBe("סימן:15");
  });

  it("a word that only LOOKS like a numeral is not a number (אחד ≠ 13; ראשון)", () => {
    expect(headingNumber("אחד")).toBeNull();
    expect(headingKey("<h2>פרק ראשון</h2>").n).toBeNull();
    expect(headingKey("<h2>פרק אחד</h2>").key).not.toBe("פרק:13");
    expect([headingNumber("טו"), headingNumber("ט\"ז"), headingNumber("קכ\"ג"), headingNumber("12")]).toEqual([15, 16, 123, 12]);
  });

  it("a daf heading in every notation, with its amud", () => {
    for (const t of ["דף ב.", "דף ב ע\"א", "דף ב עמוד א", "ב."]) expect(headingKey(`<h2>${t}</h2>`)).toMatchObject({ key: "daf:2", amud: "a" });
    for (const t of ["דף ב:", "דף ב ע\"ב", "דף ב' עמוד ב"]) expect(headingKey(`<h2>${t}</h2>`)).toMatchObject({ key: "daf:2", amud: "b" });
    expect(headingKey("<h2>דף לט</h2>")).toMatchObject({ key: "daf:39", amud: null });
  });
});

describe("heading windows by key", () => {
  const BASE_SA = ["<h1>בסיס</h1>", "<h2>סימן א - דין השכמה</h2>", "<h3>סעיף א</h3>", "יתגבר כארי לעמוד בבוקר", "<h3>סעיף ב</h3>", "המשכים להתחנן לפני בוראו", "<h2>סימן ב - דין לבישה</h2>", "<h3>סעיף א</h3>", "לא ילבש חלוקו מיושב"];

  it("סימן › סעיף › ס\"ק of the commentary scope to סימן › סעיף of the base", () => {
    const comm = ["<h1>פירוש</h1>", "<h2>סימן ב</h2>", "<h3>סעיף א</h3>", "<h4>ס\"ק א</h4>", "<b>לא ילבש.</b> פירוש"];
    expect(plan(comm, BASE_SA).windowOf(4)).toMatchObject({ kind: "heading", from: 7, to: 8 });
    expect(baseSide(byLine(run(comm, BASE_SA), 4)!).line).toBe(8);
  });

  it("a different number never matches (negative: סעיף ג is not סעיף א)", () => {
    const comm = ["<h1>פירוש</h1>", "<h2>סימן ב</h2>", "<h3>סעיף ג</h3>", "<b>לא ילבש.</b> פירוש"];
    expect(plan(comm, BASE_SA).windowOf(3)).toMatchObject({ kind: "heading", from: 6, to: 8, label: "סימן ב - דין לבישה" });
  });

  it("\"דף ב ע\"ב\" in the commentary finds \"דף ב:\" of the base; \"דף ב\" with no amud spans both", () => {
    const base = ["<h1>מסכת</h1>", "<h2>דף ב.</h2>", "משנה מאימתי קורין", "<h2>דף ב:</h2>", "גמרא תנא היכא קאי", "<h2>דף ג.</h2>", "שורה אחרת"];
    expect(plan(["<h2>דף ב ע\"ב</h2>", "x"], base).windowOf(1)).toMatchObject({ from: 3, to: 4 });
    expect(plan(["<h2>דף ב</h2>", "x"], base).windowOf(1)).toMatchObject({ from: 1, to: 4 });
  });
});

describe("unit windows: a heading that names a line the base numbers itself", () => {
  const BASE_TANAKH = ["<h1>משלי</h1>", "<h2>פרק א</h2>", "(א) משלי שלמה בן דוד", "(ב) לדעת חכמה ומוסר", "(ג) לקחת מוסר השכל", "<h2>פרק ב</h2>", "(א) בני אם תקח אמרי", "(ב) להקשיב לחכמה אזנך"];

  it("פרק › פסוק of the commentary → the verse line \"(ב)\" inside פרק א", () => {
    const comm = ["<h1>פירוש</h1>", "<h2>פרק א</h2>", "<h3>פסוק ב</h3>", "עניין הספר הוא <b>לדעת</b> חכמה", "<h2>פרק ב</h2>", "<h3>פסוק ב</h3>", "<b>להקשיב.</b> פירוש"];
    const p = plan(comm, BASE_TANAKH);
    expect(p.windowOf(3)).toMatchObject({ kind: "unit", from: 3, to: 3 });
    expect(p.windowOf(6)).toMatchObject({ kind: "unit", from: 7, to: 7 });
    expect(baseSide(byLine(run(comm, BASE_TANAKH), 6)!).line).toBe(7);
  });

  it("not for a chapter-kind heading: \"פרק ג\" under a book never means verse (ג)", () => {
    const base = ["<h1>ספר</h1>", "<h2>ספר ראשון</h2>", "(א) שורה", "(ב) שורה", "(ג) שורה"];
    const comm = ["<h1>פירוש</h1>", "<h2>ספר ראשון</h2>", "<h3>פרק ג</h3>", "פירוש"];
    expect(plan(comm, base).windowOf(3).kind).toBe("heading");
  });

  it("not when the base does not number most of its lines, nor when the number occurs twice", () => {
    const sparse = ["<h1>ס</h1>", "<h2>פרק א</h2>", "(ב) שורה", "שורה", "שורה", "שורה"];
    expect(plan(["<h2>פרק א</h2>", "<h3>פסוק ב</h3>", "x"], sparse).windowOf(2).kind).toBe("heading");
    const twice = ["<h1>ס</h1>", "<h2>פרק א</h2>", "(א) שורה", "(ב) שורה", "(א) שורה", "(ב) שורה"];
    expect(plan(["<h2>פרק א</h2>", "<h3>פסוק ב</h3>", "x"], twice).windowOf(2).kind).toBe("heading");
  });
});

describe("page windows: inline page markers of a base with no daf headings (the Zohar)", () => {
  const page = (v: string) => `<i data-overlay="Vilna Pages" data-value="${v}"></i>`;
  // 25 markers so the base counts as paged; volume 2 starts again at 2a
  const base: string[] = ["<h1>זהר</h1>", "<h2>בראשית</h2>"];
  for (let n = 1; n <= 60; n++) base.push(`${page(`${n}a`)}שורה של עמוד ${n} א`, `${page(`${n}b`)}שורה של עמוד ${n} ב`);
  base.push("<h2>שמות</h2>");
  for (let n = 2; n <= 6; n++) base.push(`${page(`${n}a`)}כרך שני עמוד ${n} א`, `${page(`${n}b`)}כרך שני עמוד ${n} ב`);
  const at = (s: string) => base.indexOf(base.find((l) => l.endsWith(s))!);

  it("כרך › דף of the commentary → the lines of that page in that volume", () => {
    const comm = ["<h1>פירוש</h1>", "<h2>כרך א</h2>", "<h3>דף ה.</h3>", "x", "<h2>כרך ב</h2>", "<h3>דף ג:</h3>", "y"];
    const p = plan(comm, base);
    expect(p.windowOf(3)).toMatchObject({ kind: "page", from: at("עמוד 5 א"), to: at("עמוד 5 ב") });
    expect(p.windowOf(6)).toMatchObject({ kind: "page", from: at("כרך שני עמוד 3 ב") });
    expect(p.distrusted).toBeUndefined();
  });

  it("a base with daf headings of its own ignores markers", () => {
    const withDaf = [...base.slice(0, 2), "<h3>דף ה.</h3>", ...base.slice(2)];
    expect(plan(["<h2>כרך א</h2>", "<h3>דף ה.</h3>", "x"], withDaf).windowOf(2).kind).toBe("heading");
  });
});
