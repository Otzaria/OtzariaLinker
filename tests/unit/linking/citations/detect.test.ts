import { describe, expect, it } from "vitest";
import type { BookOrigin } from "../../../../src/core/links/model";
import { AliasIndex, CitationScanner, mergeIbid, type Citation } from "../../../../src/linking/automatic/citations";

/*
 * Citation detection on lines written the way the library writes them (the spans are taken from
 * LINKER anchors of the official seforim.db, see docs/AUTOMATION_ENGINE.md §5). Titles are the
 * database's own.
 */
const book = (key: string, title: string, origin: BookOrigin = "sefaria", aliases: string[] = []) => ({ book: { key, title, origin }, aliases });
const CATALOG = [
  book("gen", "בראשית"),
  book("ex", "שמות"),
  book("ps", "תהילים"),
  book("kings1", "מלכים א"),
  book("ber", "ברכות"),
  book("shab", "שבת"),
  book("bk", "בבא קמא"),
  book("git", "גיטין"),
  book("yev", "יבמות"),
  book("m-ber", "משנה ברכות"),
  book("y-ber", "תלמוד ירושלמי ברכות"),
  book("rambam-shab", "משנה תורה, הלכות שבת"),
  book("sa-oc", "שולחן ערוך, אורח חיים"),
  book("tur", "טור"),
  book("mb", "משנה ברורה", "sefaria", ['מ"ב']),
  book("ma", "מגן אברהם", "sefaria", ['מג"א']),
  book("tos-ber", "תוספות על ברכות"),
  book("rashi-git", 'רש"י על גיטין'),
  book("taz", "טורי זהב על שולחן ערוך אורח חיים", "sefaria", ['ט"ז']),
];

function scan(lines: string[], sourceTitle = "ספר כלשהו", sourceKey = "src"): Citation[] {
  const ix = AliasIndex.build(CATALOG);
  const sc = new CitationScanner(ix, sourceKey, {}, sourceTitle);
  lines.forEach((l, i) => sc.scanLine(i, l, null));
  return sc.citations;
}
const one = (line: string, title?: string) => {
  const c = scan([line], title);
  expect(c, line).toHaveLength(1);
  return c[0]!;
};
const books = (c: Citation) => c.candidates.map((x) => x.book.key);
const loc = (c: Citation) => c.elems.map((e) => `${e.kind}:${e.n}${e.amud ? (e.amud === 1 ? "a" : "b") : ""}${e.maybeAmud ? `~${e.maybeAmud}` : ""}${e.to ? `-${e.to}` : ""}`).join(" ");

describe("citations: detection", () => {
  it("Tanakh: chapter and verse in the usual ways", () => {
    expect(loc(one("ויכלו (בראשית ב א) בגימטריא"))).toBe("?:2 ?:1");
    expect(loc(one("שנאמר (בראשית א׳:כ׳) ישרצו"))).toBe("?:1 ?:20");
    expect(loc(one('כמ"ש (שמות י"ב, ל"ג) תרג\''))).toBe("?:12 ?:33");
    expect(loc(one("דכתיב (תהלים נ טז) ולרשע"))).toBe("?:50 ?:16");
    expect(loc(one("ראה בראשית פרק ג פסוק ד"))).toBe("perek:3 pasuk:4");
    expect(loc(one("עיין תהלים קיט, א-ה"))).toBe("?:119 ?:1-5");
    expect(books(one("כתוב במלכים א' ג, ה"))).toEqual(["kings1"]);
  });

  it("the span is the name and the location, with prefix letters but without enclosing brackets", () => {
    const line = "ויכלו (בראשית ב א) בגימטריא";
    const c = one(line);
    expect(line.slice(c.rawStart, c.rawEnd)).toBe("בראשית ב א");
    const l2 = 'וכמבואר במשנה (ב"ק דף ט:) וז"ל';
    const c2 = one(l2);
    expect(l2.slice(c2.rawStart, c2.rawEnd)).toBe('ב"ק דף ט:');
    // brackets that open after the name belong to the span
    const l4 = 'עיין ב"ק (דף לג ע"ב) הקדישו';
    const c4 = one(l4);
    expect(l4.slice(c4.rawStart, c4.rawEnd)).toBe('ב"ק (דף לג ע"ב)');
    const l3 = "<b>ובברכות</b> דף י&quot;ז ע&quot;א ואמר";
    const c3 = one(l3);
    expect(l3.slice(c3.rawStart, c3.rawEnd)).toBe("ובברכות</b> דף י&quot;ז ע&quot;א");
  });

  it("Talmud: daf and amud in every notation", () => {
    expect(loc(one('כדאיתא בברכות (דף י"ז ע"א) ואמר'))).toBe("daf:17a");
    expect(loc(one("בשבת כג. ואמר"))).toBe("daf:23a");
    expect(loc(one("בשבת כג: ואמר"))).toBe("daf:23b");
    expect(loc(one("ברכות נה א, ושבת"))).toBe("?:55 ?:1");
    expect(loc(one('בבבא קמא ד\' ע"א איתא'))).toBe("daf:4a");
    expect(loc(one('ביבמות פ"ח ע"א איתא'))).toBe("daf:88a");
    expect(loc(one('בגיטין דף כ"ג'))).toBe("daf:23");
  });

  it("a tractate name with a chapter/mishna location is also the Mishna", () => {
    const c = one('עיין ברכות פ"א מ"ב');
    expect(loc(c)).toBe("perek:1 mishna:2");
    expect(books(c)).toEqual(["ber", "m-ber"]);
  });

  it("Rambam, Shulchan Aruch, Tur", () => {
    expect(books(one("ברמב\"ם (הל' שבת פי\"א ה\"ה) כתב"))).toEqual(["rambam-shab"]);
    expect(loc(one('הרמב"ם בפ"ג מהל\' שבת ה"ב'))).toBe("perek:3 halacha:2");
    expect(loc(one('באו"ח סי\' כ"ז דאם'))).toBe("siman:27");
    expect(books(one('באו"ח סי\' כ"ז דאם'))).toEqual(["sa-oc"]);
    const tur = one('הטור או"ח סי\' קנ"ח בחד');
    expect(books(tur)).toEqual(["tur"]);
    expect(tur.candidates[0]!.section).toBe("אורח חיים");
    expect(loc(one('ועיין מ"ב סוף סי\' ק"ו'))).toBe("siman:106");
    expect(loc(one('מג"א סי\' ש"ז ס"ק ח'))).toBe("siman:307 sk:8");
  });

  it("a collection word picks the book of that collection", () => {
    const c = one('אמנם בירושלמי פ"ק דברכות הל\' ב');
    expect(books(c)).toContain("y-ber");
    expect(c.qualifier).toBe("yerushalmi");
    expect(loc(c)).toBe("perek:1 halacha:2");
  });

  it("a commentator named before or after moves the citation into that commentary", () => {
    expect(books(one("בתוס' (ברכות יז.) והשיטה"))).toEqual(["tos-ber"]);
    // the library has no Ramban on Berachot here: the citation is dropped, not given to the Gemara
    expect(scan(['כתב הרמב"ן (ברכות יז.) ש'])).toHaveLength(0);
    // "ד"ה" right after a Talmud location points into a commentary that was not named
    expect(scan(['עיין ברכות יז. ד"ה אמר'])).toHaveLength(0);
  });

  it("לעיל / לקמן: a daf of the book a commentary is on", () => {
    const c = one('וכדאמר רב לקמן ו\' ע"א אי', "חידושי חתם סופר על גיטין");
    expect(books(c)).toEqual(["git"]);
    expect(c.form).toBe("relative");
    expect(books(one('הא דלא פי\' כן רש"י לעיל ט\' ע"ב', "חידושי חתם סופר על גיטין"))).toEqual(["rashi-git"]);
    expect(scan(["ועיין לעיל סי' ג"], "חידושי חתם סופר על גיטין")).toHaveLength(0);
    expect(scan(['לקמן ו\' ע"א'], "ספר בלי בסיס")).toHaveLength(0);
  });

  it("ibid: (שם), שם with a new location, and a book with שם", () => {
    const c = scan(["דכתיב (בראשית א, ב) ועוד", "וכתיב (שם) ושוב", "וכן (שם פסוק ד) ועוד", "ובבראשית שם"]);
    expect(c.map((x) => x.ibid)).toEqual(["none", "full", "partial", "book"]);
    expect(loc(c[2]!)).toBe("?:1 pasuk:4");
    expect(books(c[3]!)).toEqual(["gen"]);
    // a bare "שם" in running text is a word, not ibid
    expect(scan(["דכתיב (בראשית א, ב) ועוד", "ויקרא שם המקום"])).toHaveLength(1);
  });

  it("guards: words, dates, numbers that are names, the book itself", () => {
    expect(scan(["בראשית ברא אלקים"])).toHaveLength(0);
    expect(scan(["שמות ה' הם קדושים"])).toHaveLength(0);
    expect(scan(['בשבת ט"ו בשבט'])).toHaveLength(0);
    expect(scan(["בשבת לא, והלך"])).toHaveLength(0); // one bare common numeral
    // ט"ז is 16: only with an explicit marker after it
    expect(scan(['והוא ט"ז שנה'])).toHaveLength(0);
    expect(books(one('עיין ט"ז ס"ק ג'))).toEqual(["taz"]);
    expect(scan(["(בראשית א, ב)"], "בראשית", "gen")).toHaveLength(0);
  });
});

describe("citations: mergeIbid", () => {
  const e = (kind: string, n: number) => ({ kind, n, explicit: kind !== "?", numeral: { n, form: "gershayim", common: false } }) as never;
  it("replaces from the same kind, or the deepest levels for bare numbers", () => {
    expect(mergeIbid([e("?", 1), e("?", 2)], [e("?", 4)])!.map((x) => x.n)).toEqual([1, 4]);
    expect(mergeIbid([e("perek", 3), e("halacha", 2)], [e("halacha", 5)])!.map((x) => x.n)).toEqual([3, 5]);
    expect(mergeIbid([e("?", 1), e("?", 2)], [e("pasuk", 7)])!.map((x) => x.n)).toEqual([1, 7]);
    expect(mergeIbid([e("?", 1)], [e("?", 2), e("?", 3)])).toBeNull();
  });
});

describe("citations: guards found on the real library (docs/AUTOMATION_ENGINE.md §5.8)", () => {
  it("words and abbreviations that only look like locations", () => {
    expect(scan(["ירמוז לב' דברים, א' שהם בעלי מלחמות"]).every((c) => c.candidates[0]!.book.key !== "ex")).toBe(true);
    expect(scan(["ובכל בו כ' מנהגים שונים"])).toHaveLength(0); // כ' = כתב
    expect(scan(["בששי בשבת כ\"ח יום לשבט"])).toHaveLength(0); // a date three words on
    expect(scan(['וכתב בפרק יו"ד מה\' ביכורים'])).toHaveLength(0); // יו"ד = 10, מה' = מהלכות
  });

  it("compact markers in context", () => {
    expect(loc(one('כמ"ש (תהילים קי"ט: פ"ט)'))).toBe("?:119 ?:89");
    const c = one('יעו\' בפ"ד דברכות מ"ד במ"ש הרע"ב');
    expect(loc(c)).toBe("perek:4 mishna:4");
    expect(loc(one('ועיין ברכות פ"ח ע"א'))).toBe("daf:88a");
    expect(loc(one('ועי\' גיטין פ"ח: יצא'))).toBe("daf:88b");
  });

  it("ibid after a book we do not know is not our ibid", () => {
    expect(scan(["דכתיב (בראשית א, ב) ועוד", 'הביאו הפ"ת שם סק"ט'])).toHaveLength(1);
    expect(scan(["דכתיב (בראשית א, ב) ועוד", "(שם שם ד)"]).map((c) => loc(c))).toEqual(["?:1 ?:2", "?:1 ?:4"]);
  });

  it("a part after the name may carry a ב", () => {
    const t = one('ומ"ש הטור בח"מ סי\' רמ"ב');
    expect(t.candidates[0]!.section).toBe("חושן משפט");
  });
});
