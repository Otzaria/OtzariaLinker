import { describe, expect, it } from "vitest";
import type { BookOrigin } from "../../../../src/core/links/model";
import { AliasIndex, CitationScanner, NamedUnitIndex, type Citation } from "../../../../src/linking/automatic/citations";

/*
 * The forms the library benchmark found missed or wrong (docs/validation/LIBRARY_BENCHMARK.md §4.3, §6.2,
 * §6.3; docs/AUTOMATION_ENGINE.md §6.3): what the scanner reads, and the negatives each rule must keep.
 * Titles and shapes are the library's own (seforim.db).
 */
const book = (key: string, title: string, origin: BookOrigin = "sefaria", aliases: string[] = []) => ({ book: { key, title, origin }, aliases });
const CATALOG = [
  book("gen", "בראשית"),
  book("lev", "ויקרא"),
  book("deut", "דברים"),
  book("ps", "תהילים"),
  book("dan", "דניאל"),
  book("lev-r", "ויקרא רבה"),
  book("shab", "שבת"),
  book("yoma", "יומא"),
  book("kid", "קידושין", "sefaria", ["קידוש"]),
  book("ned", "נדרים"),
  book("bk", "בבא קמא"),
  book("bb", "בבא בתרא"),
  book("hul", "חולין"),
  book("tos-bk", "תוספות על בבא קמא"),
  book("tos-ned", "תוספות על נדרים"),
  book("rashi-bk", 'רש"י על בבא קמא'),
  book("rashi-hul", 'רש"י על חולין'),
  book("sa-oc", "שולחן ערוך, אורח חיים"),
  book("me", "מאירת עיניים על שולחן ערוך חושן משפט", "sefaria", ['מ"ע', 'סמ"ע']),
  book("rivash", 'תשובות הריב"ש'),
  book("tzavaat", 'צוואת הריב"ש'),
  book("oh-gen", "אור החיים על בראשית", "otzaria", ['אוה"ח']),
  book("oh-lev", "אור החיים על ויקרא", "otzaria", ['אוה"ח']),
  book("m-ned", "משנה נדרים"),
  book("ls-ned", "לחם שמים על משנה נדרים", "otzaria", ['לח"מ']),
  book("ls-shab", "לחם שמים על משנה שבת", "otzaria", ['לח"מ']),
];
/** the Bavli's chapters (alt_toc "Chapters") */
const UNITS = NamedUnitIndex.build([
  { book: { key: "bb", title: "בבא בתרא", origin: "sefaria" }, kind: "chapter", entries: [{ name: "חזקת הבתים", line: 0 }, { name: "יש נוחלין", line: 100 }, { name: "מי שמת", line: 200 }], lastLine: 299 },
  { book: { key: "bk", title: "בבא קמא", origin: "sefaria" }, kind: "chapter", entries: [{ name: "ארבעה אבות", line: 0 }, { name: "החובל", line: 100 }], lastLine: 199 },
]);

function scan(lines: (string | [string, string])[], sourceTitle = "ספר כלשהו"): Citation[] {
  const sc = new CitationScanner(AliasIndex.build(CATALOG), "src", {}, sourceTitle, UNITS);
  lines.forEach((l, n) => (Array.isArray(l) ? sc.scanLine(n, l[0], null, l[1]) : sc.scanLine(n, l, null)));
  return sc.citations;
}
const books = (c: Citation | undefined) => c?.candidates.map((x) => x.book.key) ?? [];
const loc = (c: Citation | undefined) => c?.elems.map((e) => `${e.kind}:${e.n}${e.amud ? (e.amud === 1 ? "a" : "b") : ""}${e.maybeAmud ? `/${e.maybeAmud}` : ""}`).join(" ") ?? "";

describe("places as books write them", () => {
  it('"ד\'" with no numeral after it is the number 4, not "דף"', () => {
    const [c] = scan(['וכדכתיב (דניאל ד\', כ"ד) פרוק']);
    expect(books(c)).toEqual(["dan"]);
    expect(loc(c)).toBe("?:4 ?:24");
    // "ד' ע"א" stays daf 4
    expect(loc(scan(['כמבואר בשבת ד\' ע"א'])[0])).toBe("daf:4a");
  });
  it('a ד glued to the daf before a lone amud letter: "ביומא דנ"ד א\'"', () => {
    const [c] = scan(["כדאיתא ביומא דנ״ד א׳ ושם"]);
    expect(books(c)).toEqual(["yoma"]);
    expect(loc(c)).toBe("daf:54/1");
  });
  it("two numerals in brackets are a place even when one is an everyday word; not in running text", () => {
    expect(loc(scan(["ומצינו (בראשית מו א, ועיין שם עוד)"])[0])).toBe("?:46 ?:1");
    expect(scan(["ויאמר בראשית מו א"])).toHaveLength(0);
  });
  it('a word for "see" between the bracket and the name: "(עיין שבת נה)"', () => {
    expect(books(scan(["וזה מותר (עיין שבת נה) ואין לחוש"])[0])).toEqual(["shab"]);
    expect(scan(["וזה מותר עיין שבת נה ואין לחוש"])).toHaveLength(0);
  });
});

describe("a commentator's ד\"ה", () => {
  it('"תו\'" is תוספות', () => {
    const [c] = scan(['ועיין תו\' ב"ק כ"ג ע"ב ד"ה ואי']);
    expect(books(c)).toEqual(["tos-bk"]);
  });
  it('"תוד"ה" after a citation moved to רש"י is on the same tractate; "ושם ע"ב ד"ה" is the other amud', () => {
    const cs = scan(['ועיין רש"י ב"ק כ"ג ע"א ד"ה ואי', 'ועיין תוד"ה ואי שהקשו', 'ושם ע"ב ד"ה אלא כתבו']);
    expect(cs.map(books)).toEqual([["rashi-bk"], ["tos-bk"], ["tos-bk"]]);
    expect(loc(cs[2])).toBe("daf:23b");
    expect(cs[2]!.rule).toBe("ibid-amud");
    expect(cs[2]!.dh).toEqual(["אלא", "כתבו"]);
  });
  it('"ושם ע"ב" after the Gemara is its other amud; with a ד"ה and no commentator, nothing', () => {
    const cs = scan(['כדאמרינן בב"ק כ"ג ע"א', 'ושם ע"ב אמרו']);
    expect(books(cs[1])).toEqual(["bk"]);
    expect(loc(cs[1])).toBe("daf:23b");
    expect(scan(['כדאמרינן בב"ק כ"ג ע"א', 'ושם ע"ב ד"ה אלא'])).toHaveLength(1);
  });
  it('"רש"י ד"ה X" with no daf: the daf of the citing line, in a commentary on the tractate', () => {
    const [c] = scan([['רש"י ד"ה ואי מאי קאמר', "חידושים על בבא קמא, כג:, ב"]], "חידושים על בבא קמא");
    expect(books(c)).toEqual(["rashi-bk"]);
    expect(loc(c)).toBe("daf:23b");
    expect(c!.rule).toBe("dibur-here");
    // without the line's reference, nothing
    expect(scan(['רש"י ד"ה ואי מאי קאמר'], "חידושים על בבא קמא")).toHaveLength(0);
  });
  it("a commentary named by its name in the library, when it is on the cited book", () => {
    const [c] = scan(['ובאוה"ח [ויקרא א, ב] כתב']);
    expect(books(c)).toEqual(["oh-lev"]);
    expect(c!.rule).toBe("commentator-named");
    // no אור החיים on דברים in the library: the verse
    expect(books(scan(['ובאוה"ח [דברים א, ב] כתב'])[0])).toEqual(["deut"]);
    // the acronym must be the author's initials: "לח"מ" is לחם משנה, not the database's name of לחם שמים
    expect(books(scan(['ובלח"מ [רפ"ה דנדרים] כתב'])[0])).not.toContain("ls-ned");
  });
  it('a commentator after the place moves it only with its ד"ה', () => {
    expect(books(scan(['ושותים בצמאה (ב"ק פד:), כרש"י ובעלי התוספות'])[0])).toEqual(["bk"]);
  });
});

describe("a chapter by its name with no \"פרק\"", () => {
  it("only with a bracketed daf right after it", () => {
    const [c] = scan(["ביש נוחלין (קלח:) אמרו"]);
    expect(books(c)).toEqual(["bb"]);
    expect(c!.rule).toBe("named-bare");
    expect(c!.unit?.name).toBe("יש נוחלין");
    expect(books(scan(['וכן אמרו בהחובל [פ"ז ע"א] שהוא'])[0])).toEqual(["bk"]);
    // no daf, or no bracket: a word
    expect(scan(["ביש נוחלין אמרו"])).toHaveLength(0);
    expect(scan(["ביש נוחלין קלח: אמרו"])).toHaveLength(0);
  });
});

describe("responsa by their author", () => {
  it("his other work with the same siman is no tie: it is scored below", () => {
    const [c] = scan(['וכן כתב הריב"ש סי\' קמ"ב בתשובתו']);
    expect(books(c)).toEqual(["rivash", "tzavaat"]);
    expect(c!.candidates.find((x) => x.book.key === "tzavaat")!.otherWork).toBe(true);
  });
});

describe("guards from the hand check of new references (LIBRARY_BENCHMARK §4.3)", () => {
  it('"כתלים" is walls, not כ + a spelling of תהילים; a title with כ stays', () => {
    expect(scan(["שני [כתלים מב'] צדי הבית"])).toHaveLength(0);
    expect(books(scan(['כמבואר [כשבת ח\' ע"ב]'])[0])).toEqual(["shab"]);
  });
  it('the database\'s truncation "קידוש" is no name', () => {
    expect(scan(['וכן מצינו [בקידוש י"ט] שאמרו'])).toHaveLength(0);
  });
  it("digits alone in a bracket of their own are a note's number", () => {
    expect(scan(["לכבוד [שבת (95)] קודש"])).toHaveLength(0);
  });
  it('"מ"ע" is מצוות עשה, not מאירת עיניים', () => {
    expect(scan(['וכן כתב הסמ"ג [מ"ע סימן כ"א] בשם'])).toHaveLength(0);
  });
  it("a part of the Shulchan Aruch right after a work of responsa is that work's part", () => {
    expect(scan(['ובשו"ת חת"ס או"ח סי\' ס"ב כתב'])).toHaveLength(0);
    expect(books(scan(['ובשו"ע או"ח סי\' ס"ב כתב'])[0])).toEqual(["sa-oc"]);
  });
  it("a count after the numbers, or a quantifier before an everyday title, is no place", () => {
    expect(scan(["אם ישב בשבת ח' ימים"])).toHaveLength(0);
    expect(scan(["וזה נעשה בשני דברים א' בתחלת המחשבה"])).toHaveLength(0);
    expect(scan(["(שבת ח') ימים"])).toHaveLength(1);
  });
  it('"מדרש רבה [ויקרא פכ"ב]" is ויקרא רבה, and "ברבות" too', () => {
    const [c] = scan(['ובמדרש רבה [ויקרא פכ"ב] איתא']);
    expect(books(c)).toEqual(["lev-r"]);
    expect(c!.rule).toBe("midrash-rabbah");
    expect(books(scan(["ברבות פ' [ויקרא פ' ד']"])[0])).toEqual(["lev-r"]);
    // a midrash not in the library: no link, and not to the verse
    expect(scan(['ובמדרש רבה [בראשית פי"א] איתא'])).toHaveLength(0);
  });
  it('a glossary of Rashi\'s words cites Rashi', () => {
    const [c] = scan(["פירוש המילה (חולין פד:) כך"], 'אוצר לעזי רש"י');
    expect(books(c)).toEqual(["rashi-hul"]);
    expect(c!.rule).toBe("title-commentator");
    expect(books(scan(["פירוש המילה (חולין פד:) כך"], "אוצר מילים")[0])).toEqual(["hul"]);
  });
});
