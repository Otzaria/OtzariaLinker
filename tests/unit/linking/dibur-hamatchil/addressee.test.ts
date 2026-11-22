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
