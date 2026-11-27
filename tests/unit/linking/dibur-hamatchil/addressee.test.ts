import { describe, expect, it } from "vitest";
import { headingLevel } from "../../../../src/core/text/html";
import { extractDh, runDiburHamatchilEngine, type DhOptions } from "../../../../src/linking/automatic/dibur-hamatchil";
import type { EngineBook, EngineResult } from "../../../../src/linking/automatic/types";
import { commentatorOfTitle } from "../../../../src/linking/automatic/dibur-hamatchil/addressee";

/*
 * Issue #10: the commentators of the Shulchan Aruch as the addressee of a ד"ה line ("ש"ך ד"ה …", "במג"א בד"ה …"),
 * next to the Talmud's (רש"י, תוספות…). The names are the idea of Otzaria/otzaria-link-generator @c51c4c9
 * (src/data/halachaCommentators.ts): a commentator's name and its written forms.
 */
const who = (line: string) => {
  const a = extractDh(line).addressee;
  return a?.kind === "named" ? a.commentator.key : (a?.kind ?? null);
};

describe("the Shulchan Aruch's commentators as the addressee of a ד\"ה line", () => {
  it.each([
    ['ש"ך ד"ה כל המשלח', "shach"],
    ['בש"ך בד"ה והנה', "shach"],
    ['ט"ז ד"ה ולענין', "taz"],
    ['בט"ז ד"ה ואם', "taz"],
    ['במג"א ד"ה מותר', "magen_avraham"],
    ['סמ"ע ד"ה אינו', "sma"],
    ['ב"ש ד"ה שהרי', "beit_shmuel"],
    ['ח"מ ד"ה והא', "chelkat_mechokek"],
    ['באה"ט ד"ה ולא', "baer_heitev"],
    ['פת"ש ד"ה ואין', "pitchei_teshuva"],
    ['מ"ב ד"ה ובדיעבד', "mishna_berura"],
    ['בה"ל ד"ה ואם', "biur_halacha"],
    ['קצה"ח ד"ה והנה', "ketzot"],
  ])("%s → %s", (line, key) => {
    expect(who(line)).toBe(key);
  });

  it("the Talmud's commentators still work", () => {
    expect(who('רש"י ד"ה בראשית')).toBe("rashi");
    expect(who('בתוס\' בד"ה והא')).toBe("tosafot");
  });

  it("a name that is not followed by ד\"ה is not an addressee (no blind routing)", () => {
    expect(who('ש"ך שאין כן דעת הרמ"א')).toBeNull();
    expect(who('ועיין ט"ז סימן ג')).toBeNull();
    expect(who("ד\"ה כל המשלח")).toBe("bare");
  });
});

describe("the commentator a BOOK is, by its title", () => {
  it.each([
    ["שפתי כהן על שולחן ערוך חושן משפט", "shach"],
    ["טורי זהב על שולחן ערוך אורח חיים", "taz"],
    ["מאירת עיניים על שולחן ערוך חושן משפט", "sma"],
    ["קצות החושן על שולחן ערוך חושן משפט", "ketzot"],
    ["פתחי תשובה על שולחן ערוך יורה דעה", "pitchei_teshuva"],
    ["מגן אברהם", "magen_avraham"],
    ["משנה ברורה", "mishna_berura"],
    ["ביאור הלכה", "biur_halacha"],
    ["בית שמואל", "beit_shmuel"],
    ["חלקת מחוקק", "chelkat_mechokek"],
    ["באר היטב אורח חיים", "baer_heitev"],
    ["באר היטב חשן משפט", "baer_heitev"],
  ])("%s → %s", (title, key) => {
    expect(commentatorOfTitle(title)?.key).toBe(key);
  });

  it("the text itself and other books are not commentators", () => {
    expect(commentatorOfTitle("שולחן ערוך, אורח חיים")).toBeNull();
    expect(commentatorOfTitle("שולחן ערוך חושן משפט")).toBeNull();
    expect(commentatorOfTitle("באר היטב")).toBeNull(); // a bare title names no part of the SA
    expect(commentatorOfTitle("ספר כלשהו")).toBeNull();
    expect(commentatorOfTitle('רש"י על בראשית')?.key).toBe("rashi");
  });
});

describe("the engine routes a line that names the Shach to the Shach, not to the Shulchan Aruch", () => {
  const ref = (key: string, title: string) => ({ key, title, origin: "otzaria" as const });
  const book = (r: ReturnType<typeof ref>, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });
  const SA = ref("sa", "שולחן ערוך, חושן משפט");
  const SHACH = ref("shach", "שפתי כהן על שולחן ערוך חושן משפט");
  const COMM = ref("comm", "קצות החושן על שולחן ערוך חושן משפט");
  // invented neutral words: no book text
  const sa = ["<h1>שולחן ערוך, חושן משפט</h1>", "<h2>סימן א</h2>", "אלפא בטא גמא דלתא הא וו זין חית טית", "יוד כף למד מם נון סמך עין פא צדי קוף"];
  const shach = ["<h1>שפתי כהן על שולחן ערוך חושן משפט</h1>", "<h2>סימן א</h2>", "<b>אלפא בטא גמא</b> – פירוש שלו", "<b>יוד כף למד</b> – פירוש שני"];
  const comm = ["<h1>קצות החושן</h1>", "<h2>סימן א</h2>", '<b>אלפא בטא גמא</b> ועוד דברים כאן', 'ש"ך ד"ה יוד כף למד עיין שם'];
  const run = (base: ReturnType<typeof ref>, lines: readonly string[], opts: DhOptions = {}) => runDiburHamatchilEngine(book(COMM, comm), book(base, lines), opts);
  const why = (res: EngineResult, line: number) => res.unmatched.find((u) => u.line === line)?.reasons.map((r) => r.code) ?? [];

  it("with the SA as base the Shach line is set aside ('intermediate'); with the Shach as base only that line is searched", () => {
    expect(why(run(SA, sa), 3)).toEqual(["dh/intermediate"]);
    const res = run(SHACH, shach, { addressedOnly: true });
    expect(res.suggestions.map((s) => (s.source.book.key === "comm" ? s.source.line : s.target.line))).toEqual([3]);
    expect(why(res, 2)).toEqual(["dh/not-addressed"]);
  });
});

/*
 * #41 B13, issues #10 and #45, V7 §2.7: a commentary on the Shulchan Aruch often names the commentator it is about with a NUMBER and no
 * quotation — "בש"ך ס"ק ג - …", "סמ"ע ס"ק ז" — and such a line was linked to the PREVIOUS line of the Mechaber at "high". The default
 * is the primary base; only explicit evidence routes a line to another book: a name with ד"ה, or a name with a seif katan.
 */
describe("a numeric reference to a commentator of the Shulchan Aruch (#41 B13, #10, #45)", () => {
  const seif = (line: string) => {
    const a = extractDh(line).addressee;
    return a?.kind === "named" ? `${a.commentator.key}:${a.seifKatan ?? "-"}` : (a?.kind ?? null);
  };
  it.each([
    ['בש"ך ס"ק ג - כתב שם דבר', "shach:3"],
    ['ש"ך סק"ג כתב שם', "shach:3"],
    ['סמ"ע ס"ק ז ועיין שם', "sma:7"],
    ['בט"ז ס"ק יב: והנה', "taz:12"],
    ["במג\"א סעיף קטן ד שכתב", "magen_avraham:4"],
    ['ש"ך ד"ה כל המשלח', "shach:-"],
  ])("%s → %s", (line, expected) => expect(seif(line)).toBe(expected));
  it("a number with no commentator's name, or a name in the middle of the line, routes nothing", () => {
    expect(String(seif("ס\"ק ג כתב שם"))).not.toMatch(/^shach/);
    expect(String(seif(`והנה כתב הש"ך ס"ק ג`))).not.toMatch(/^shach/);
  });

  const ref = (key: string, title: string) => ({ key, title, origin: "otzaria" as const });
  const book = (r: ReturnType<typeof ref>, texts: readonly string[]): EngineBook => ({ book: r, lines: texts.map((text, index) => ({ index, text, heading: headingLevel(text) })) });
  const SA = ref("sa", "שולחן ערוך, יורה דעה");
  const SHACH = ref("shach", "שפתי כהן על שולחן ערוך יורה דעה");
  const COMM = ref("comm", "ביאור על שולחן ערוך יורה דעה");
  // invented neutral words: no book text
  const sa = ["<h1>שולחן ערוך, יורה דעה</h1>", "<h2>סימן א</h2>", "אלפא בטא גמא דלתא הא וו זין חית טית", "יוד כף למד מם נון סמך עין פא צדי קוף", "<h2>סימן ב</h2>", "ריש שין תיו אלפא בטא גמא"];
  const shach = ["<h1>שפתי כהן על שולחן ערוך יורה דעה</h1>", "<h2>סימן א</h2>", "(א) <b>אלפא בטא</b> – פירוש ראשון", "(ב) <b>דלתא הא</b> – פירוש שני", "(ג) <b>יוד כף</b> – פירוש שלישי", "<h2>סימן ב</h2>", "(א) <b>ריש שין</b> – פירוש", "(ב) <b>תיו אלפא</b> – פירוש", "(ג) <b>בטא גמא</b> – פירוש"];
  const comm = ["<h1>ביאור על שולחן ערוך יורה דעה</h1>", "<h2>סימן א</h2>", "<b>אלפא בטא גמא דלתא</b> ועוד דברים כאן", 'בש"ך ס"ק ג - כתב דבר חדש שאינו בלשון המחבר כלל', "<h2>סימן ב</h2>", '<b>ריש שין תיו</b> פירוש נוסף', 'סמ"ע ס"ק ז ועיין שם'];
  const run = (base: ReturnType<typeof ref>, lines: readonly string[], opts: DhOptions = {}) => runDiburHamatchilEngine(book(COMM, comm), book(base, lines), opts);
  const why = (res: EngineResult, line: number) => res.unmatched.find((u) => u.line === line)?.reasons.map((r) => r.code) ?? [];
  const commLines = (res: EngineResult) => res.suggestions.map((s) => (s.source.book.key === "comm" ? s.source.line : s.target.line));

  it("with the Mechaber as base, the line about the Shach's seif katan is set aside — never linked to the line before it", () => {
    const res = run(SA, sa);
    expect(commLines(res)).not.toContain(3);
    expect(why(res, 3)).toEqual(["dh/intermediate"]);
    expect(commLines(res)).not.toContain(6);
    expect(why(res, 6)).toEqual(["dh/intermediate"]);
  });

  it("with the Shach as base, the line goes to seif katan ג of the Shach in the same siman, by its number alone", () => {
    const res = run(SHACH, shach, { addressedOnly: true });
    const s = res.suggestions.find((x) => (x.source.book.key === "comm" ? x.source.line : x.target.line) === 3)!;
    expect(s).toBeDefined();
    expect(s.source.book.key === "shach" ? s.source.line : s.target.line).toBe(4);
    expect(s.rules).toContain("dh/seif-katan");
    expect(["certain", "high"]).toContain(s.confidence);
  });
});
