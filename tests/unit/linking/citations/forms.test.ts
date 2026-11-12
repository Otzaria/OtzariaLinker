import { describe, expect, it } from "vitest";
import type { BookOrigin } from "../../../../src/core/links/model";
import { AliasIndex, buildRefIndex, CitationScanner, dafStructureFromAltToc, NamedUnitIndex, resolveAltDaf, runCitationsEngine, type Citation, type RefLine } from "../../../../src/linking/automatic/citations";

/*
 * The forms added for V4 (docs/AUTOMATION_ENGINE.md §6.3): a location in brackets with no book, a named
 * level after a book ("תנחומא, משפטים ב", "בזוה"ק בשלח (נב:)"), the Zohar's pagination, responsa by
 * their author, the Rambam's topics in short, an author's name narrowed by a part of the Shulchan Aruch,
 * "שם" in more shapes, and a commentator's ד"ה on the daf the context gives. Titles and shapes are the
 * library's own (seforim.db); each rule has its negatives.
 */
const book = (key: string, title: string, origin: BookOrigin = "sefaria", aliases: string[] = []) => ({ book: { key, title, origin }, aliases });
const CATALOG = [
  book("gen", "בראשית"),
  book("ex", "שמות"),
  book("ps", "תהילים"),
  book("yev", "יבמות"),
  book("ket", "כתובות"),
  book("bk", "בבא קמא"),
  book("git", "גיטין"),
  book("tos-yev", "תוספות על יבמות"),
  book("rashi-bk", 'רש"י על בבא קמא'),
  book("tanch", "מדרש תנחומא", "sefaria", ["תנחומא"]),
  book("tanch-b", "תנחומא בובר", "sefaria", ["תנחומא"]),
  book("zohar", "ספר הזהר"),
  book("rivash", 'תשובות הריב"ש'),
  book("tzavaat", 'צוואת הריב"ש'),
  book("rosh-t", 'תשובות הרא"ש'),
  book("rashba4", 'שו"ת הרשב"א חלק ד'),
  book("rashba6", 'שו"ת הרשב"א חלק ו'),
  book("mt-yt", "משנה תורה, הלכות שביתת יום טוב"),
  book("mt-mk", "משנה תורה, הלכות מעשה הקרבנות"),
  book("mt-sl", "משנה תורה, הלכות שופר וסוכה ולולב"),
  book("mt-tt", "משנה תורה, הלכות תלמוד תורה"),
  book("mt-ed", "משנה תורה, הלכות עדות"),
  book("mt-shab", "משנה תורה, הלכות שבת"),
  book("sa-yd", "שולחן ערוך, יורה דעה"),
  book("sa-cm", "שולחן ערוך, חושן משפט"),
  book("shach-yd", "שפתי כהן על שולחן ערוך יורה דעה", "sefaria", ['ש"ך']),
  book("shach-cm", "שפתי כהן על שולחן ערוך חושן משפט", "sefaria", ['ש"ך']),
];
/** the Torah's parshiyot (alt_toc "Parasha"), for the named levels */
const UNITS = NamedUnitIndex.build([
  { book: { key: "gen", title: "בראשית", origin: "sefaria" }, kind: "parsha", entries: [{ name: "בראשית", line: 0 }, { name: "לך לך", line: 50 }], lastLine: 99 },
  { book: { key: "ex", title: "שמות", origin: "sefaria" }, kind: "parsha", entries: [{ name: "בשלח", line: 0 }, { name: "משפטים", line: 40 }, { name: "כי תשא", line: 70 }], lastLine: 99 },
]);

function scan(lines: (string | [string, number])[], sourceTitle = "ספר כלשהו"): Citation[] {
  const ix = AliasIndex.build(CATALOG);
  const sc = new CitationScanner(ix, "src", {}, sourceTitle, UNITS);
  let n = 0;
  for (const l of lines) {
    if (Array.isArray(l)) sc.scanLine(n++, l[0], l[1]);
    else sc.scanLine(n++, l, null);
  }
  return sc.citations;
}
const books = (c: Citation | undefined) => c?.candidates.map((x) => x.book.key) ?? [];
const loc = (c: Citation | undefined) => c?.elems.map((e) => `${e.kind}:${e.n}${e.amud ? (e.amud === 1 ? "a" : "b") : ""}`).join(" ") ?? "";

describe("a location in brackets with no book: the context's book", () => {
  it("the citation right before, when near and of the same shape", () => {
    // in the same line: "high"
    const [, b] = scan(["כמו שנאמר (בראשית א, א) ונאמר עוד ויאמר (ב, ג) וגו'"]);
    expect(books(b)).toEqual(["gen"]);
    expect(loc(b)).toBe("?:2 ?:3");
    expect(b!.rule).toBe("implicit-previous");
    // a line on, or a daf: the same book, but "possible" (one in four was wrong by hand)
    expect(scan(["כמו שנאמר (בראשית א, א) ונאמר עוד", "ויאמר (ב, ג) וגו'"])[1]!.rule).toBe("implicit-previous-far");
    const [, d] = scan(['כמו ששנינו [כתובות מ"ד ע"א] וכן', 'ואמרו [מ"ה ע"ב] אמרו']);
    expect(books(d)).toEqual(["ket"]);
    expect(d!.rule).toBe("implicit-previous-far");
    // "כביבמות ([צ.])": a tractate right before the bracket (with three prefix letters) is the place's own
    expect(scan(['ששנינו [כתובות מ"ד ע"א] וכן', "כביבמות ([צ.]) וכן"])).toHaveLength(1);
    // a daf after a verse, or a verse after a daf, is not the same book
    expect(scan(["כמו שנאמר (בראשית א, א)", 'ושם [מ"ה ע"ב] אמרו'])).toHaveLength(1);
    expect(scan(['ששנינו [כתובות מ"ד ע"א]', "ונאמר (ב, ג)"])).toHaveLength(1);
    // further than three lines: nothing
    expect(scan(["כמו שנאמר (בראשית א, א)", "א", "ב", "ג", "ויאמר (ב, ג)"])).toHaveLength(1);
  });

  it("a book of the Torah the headings name; nothing without context, nor after another book's name", () => {
    const c = scan([["<h2>ספר שמות</h2>", 2], ["<h3>פרשת בשלח</h3>", 3], "ויאמר משה (י\"ד, י\"ג) אל תיראו"]);
    expect(books(c[0])).toEqual(["ex"]);
    expect(c[0]!.rule).toBe("implicit-context");
    expect(scan(["ויאמר משה (י\"ד, י\"ג) אל תיראו"])).toHaveLength(0);
    // "(א)" alone is a note mark, and a single bare number is no place
    expect(scan([["<h2>ספר שמות</h2>", 2], "ויאמר (א) משה (ט\"ו)"])).toHaveLength(0);
    // a book named a few words before is the place's book (it would be read with it, or not at all)
    expect(scan([["<h2>ספר שמות</h2>", 2], 'כדאיתא בגיטין שם (ב, ג) וגו\'']).every((x) => !books(x).includes("ex"))).toBe(true);
  });
});

describe("a named level after a book, and the Zohar by its pages", () => {
  it('"תנחומא, משפטים ב", "תנחומא פרשת לך לך סי\' ט\'": the parsha, then the place under it', () => {
    const [a] = scan(["שנאמר (תנחומא, משפטים ב), לא"]);
    expect(books(a)).toEqual(["tanch"]);
    expect(a!.unit).toMatchObject({ kind: "parsha", name: "משפטים", context: "named" });
    expect(loc(a)).toBe("?:2");
    expect(scan(["עפ\"י תנחומא פרשת לך לך סי' ט', וע\"ע"])[0]!.unit?.name).toBe("לך לך");
    // "דתנחומא (בראשית א, א)": a book of the Torah with chapter and verse is the verse, not the book's level
    const v = scan(["כדתנחומא (בראשית א, א) וכו'"]);
    expect(v.map((c) => books(c))).toEqual([["gen"]]);
    // a parsha alone after the book (no place) is "בזוהר פרשת X" (named()); after a book of the Torah it is no level
    expect(scan(["כמו שכתוב בתנחומא משפטים ושם"])).toHaveLength(0);
  });

  it('"בזוה"ק בשלח (נב:)", "זוה"ק ח"א פ"ט ע"ב", "בזוהר (חלק א דף קטו ע"א)": a daf, its volume or its parsha', () => {
    const [a] = scan(['כדאיתא בזוה"ק בשלח (נב:) בעתיקא']);
    expect(books(a)).toEqual(["zohar"]);
    expect(loc(a)).toBe("daf:52b");
    expect(loc(scan(['עיין זוה"ק ח"א פ"ט ע"ב).'])[0])).toBe("chelek:1 daf:89b");
    expect(loc(scan(['שאמרו בזוהר (חלק א דף קטו ע"א) על'])[0])).toBe("chelek:1 daf:115a");
    // "ח"ו" alone is "חס ושלום", not a part
    expect(scan(['ובזוהר ח"ו לומר כן'])).toHaveLength(0);
  });

  it("the pagination: volumes counted by the dafim starting again, a parsha's daf found inside it", () => {
    const zohar = { key: "zohar", title: "ספר הזהר", origin: "sefaria" as const };
    // alt_toc "Daf": the volume entries point at no line (the reader drops them); the dafim restart
    const entries = [
      { heTitle: "הקדמה", line: 1, level: 0 },
      ...Array.from({ length: 120 }, (_, i) => ({ heTitle: `דף ${gem(Math.floor(i / 2) + 1)}${i % 2 ? ":" : "."}`, line: 2 + i * 2, level: 1 })),
      { heTitle: "שמות", line: 250, level: 0 },
      ...Array.from({ length: 60 }, (_, i) => ({ heTitle: `דף ${gem(Math.floor(i / 2) + 2)}${i % 2 ? ":" : "."}`, line: 250 + i * 2, level: 1 })),
    ];
    const ds = dafStructureFromAltToc(zohar, [{ key: "Daf", entries }], 380)!;
    expect(new Set(ds.entries.map((e) => e.volume))).toEqual(new Set([1, 2]));
    const daf = (n: number, amud: 1 | 2) => [{ kind: "daf" as const, n, amud, explicit: true, numeral: { n, form: "gershayim" as const, common: false } }];
    const part = (v: number) => ({ kind: "chelek" as const, n: v, explicit: true, numeral: { n: v, form: "gershayim" as const, common: false } });
    // דף ה: of volume 1 is the 10th entry (1-based line 2 + 9*2 = 20 → 0-based 19); of volume 2 (which starts at דף ב) the 8th of its own, 1-based 250 + 7*2 = 264
    expect(resolveAltDaf(ds, [part(1), ...daf(5, 2)], null)).toMatchObject({ line: 19, end: 20, via: "pages" });
    expect(resolveAltDaf(ds, [part(2), ...daf(5, 2)], null)).toMatchObject({ line: 263 });
    // no volume and no parsha: the daf is in both — no guess
    expect(resolveAltDaf(ds, daf(5, 2), null)).toBeNull();
    // the parsha's lines (from the book's own references) pick the volume
    expect(resolveAltDaf(ds, daf(5, 2), { key: "שמות", span: { line: 249, end: 380 } })).toMatchObject({ line: 263 });
  });
});

describe("responsa by their author", () => {
  it("the author's name and a siman; a word for responsa lets a famous author's name through", () => {
    const [a] = scan(["כתב הריב\"ש סי' ת\"ו דרבי"]);
    // "צוואת הריב"ש" names the author too: both are candidates, and the place decides
    expect(books(a)).toEqual(["rivash", "tzavaat"]);
    expect(a!.rule).toBe("responsa-author");
    const [b] = scan(["בתשובת הרא\"ש כלל ל\"ה סי' ד' ע\"ש"]);
    expect(books(b)).toEqual(["rosh-t"]);
    expect(loc(b)).toBe("klal:35 siman:4");
    expect(b!.rule).toBe("responsa-named");
    // "הרא"ש סי' ה" alone may be his work on the Talmud: nothing
    expect(scan(["וכן כתב הרא\"ש סי' ה' שם"])).toHaveLength(0);
  });

  it("a work in parts needs its part", () => {
    expect(books(scan(["כמ\"ש בשו\"ת הרשב\"א ח\"ד סי' ל\"ו"])[0])).toEqual(["rashba4"]);
    expect(books(scan(["כמ\"ש בתשו' הרשב\"א ח\"ו סי' ה'"])[0])).toEqual(["rashba6"]);
    expect(scan(["כמ\"ש בתשו' הרשב\"א סי' ל\"ו"])).toHaveLength(0);
  });
});

describe("the Rambam's topics in short", () => {
  it("initials of words anywhere in the topic, a later word, the halacha before the topic, the author before it", () => {
    const one = (l: string) => {
      const c = scan([l]);
      expect(c, l).toHaveLength(1);
      return c[0]!;
    };
    expect(books(one("ובפ\"ה מהל' יו\"ט"))).toEqual(["mt-yt"]);
    expect(books(one("רמב\"ם פי\"ח ממע\"ק"))).toEqual(["mt-mk"]);
    expect(books(one("ובפ\"ח ה\"א מהל' לולב"))).toEqual(["mt-sl"]);
    expect(loc(one("ובפ\"ח ה\"א מהל' לולב"))).toBe("perek:8 halacha:1");
    expect(loc(one("וברמב\"ם פי\"א ה\"י מהל' עדות"))).toBe("perek:11 halacha:10");
    const t = one("רמב\"ם ת\"ת פ\"ג, הי\"ב");
    expect(books(t)).toEqual(["mt-tt"]);
    expect(t.elems[0]!.alsoNumber).toBeUndefined();
    // without "רמב"ם" or a word for "הלכות" the same letters are no topic
    expect(scan(["ובפ\"ה מיו\"ט"])).toHaveLength(0);
    // the author and a word that is no topic: nothing
    expect(scan(["הרמב\"ם שבת דף ה"])).toHaveLength(0);
  });
});

describe("an author's name narrowed by a part, and the end of a siman", () => {
  it('"ש"ך חו"מ סי\' צ"א": the ש"ך on חושן משפט, not the Shulchan Aruch', () => {
    const [a] = scan(["ועי' היטב במ\"ש ש\"ך חו\"מ סי' צ\"א:"]);
    expect(books(a)).toEqual(["shach-cm"]);
    expect(books(scan(["הש\"ך ביו\"ד סי' רל\"ב הקשה"])[0])).toEqual(["shach-yd"]);
    // without a part the name says nothing
    expect(scan(["כמ\"ש הש\"ך סי' רל\"ב"])).toHaveLength(0);
  });

  it('"ס"ס", "ססי\'", "רסי\'" are a siman; a second siman with "ו" is a second place', () => {
    expect(loc(scan(["עיין [יו\"ד ס\"ס קכ\"ח] ושם"])[0])).toBe("siman:128");
    expect(loc(scan(["וכ\"כ בחו\"מ ססי' רמ\"ו"])[0])).toBe("siman:246");
    expect(loc(scan(["עיין חו\"מ סי' ג' וסי' ד'"])[0])).toBe("siman:3");
  });
});

describe('"שם" in more shapes, and a commentator\'s ד"ה on the daf of the context', () => {
  it('"ושם", "(שם, שם, י"ח)", and a far "שם" with a place of its own', () => {
    const c = scan(["כמו שנאמר (תהלים א, א)", "ושם (ב, ג) נאמר", "(שם, שם, י\"ח)"]);
    expect(c.map((x) => [x.ibid, loc(x)])).toEqual([
      ["none", "?:1 ?:1"],
      ["partial", "?:2 ?:3"],
      ["partial", "?:2 ?:18"],
    ]);
    const far = scan(["כמו שנאמר (תהלים א, א)", ...Array.from({ length: 9 }, () => "טקסט"), "ועיין (שם ב, ג)", "וכן (שם)"]);
    // the far "שם" is the last citation now: "(שם)" right after it is near again
    expect(far.map((x) => x.rule ?? x.ibid)).toEqual(["none", "ibid-far", "full"]);
    // "(שם)" alone, far: nothing
    expect(scan(["כמו שנאמר (תהלים א, א)", ...Array.from({ length: 9 }, () => "טקסט"), "וכן (שם)"])).toHaveLength(1);
  });

  it('"וכתבו בתוס\' [ד"ה רבי", "רש"י שם ד"ה שלא": the commentary on the daf just cited', () => {
    const [, a] = scan(['רבי מאיר מחייב" [יבמות פ"ז ע"ב], וכתבו בתוס\' [ד"ה רבי מאיר] דלא']);
    expect(books(a)).toEqual(["tos-yev"]);
    expect(loc(a)).toBe("daf:87b");
    expect(a!.rule).toBe("dibur-context");
    const [, b] = scan(['מקבלין עדים [ב"ק קי"ב ע"ב] ופירש רש"י שם ד"ה שלא בפני']);
    expect(books(b)).toEqual(["rashi-bk"]);
    // no ד"ה: "תוס' שם" may be anything; no daf near: nothing
    expect(scan(['[יבמות פ"ז ע"ב] וכתבו בתוס\' שם דלא'])).toHaveLength(1);
    expect(scan(['וכתבו בתוס\' [ד"ה רבי מאיר] דלא'])).toHaveLength(0);
  });

  it("the engine links a commentator's ד\"ה to that commentary, below the citation it completes", () => {
    const tos: RefLine[] = [{ index: 0, heRef: null }, { index: 1, heRef: "תוספות על יבמות, פז:, א, א" }, { index: 2, heRef: "תוספות על יבמות, פז:, ב, א" }];
    const yev: RefLine[] = [{ index: 0, heRef: null }, { index: 1, heRef: "יבמות, פז:, א" }];
    const lib = {
      catalog: [{ book: { key: "yev", title: "יבמות", origin: "sefaria" as const } }, { book: { key: "tos-yev", title: "תוספות על יבמות", origin: "sefaria" as const } }],
      index: (b: { key: string; title: string; origin: BookOrigin }) => buildRefIndex(b, b.key === "yev" ? yev : tos),
    };
    const src = { book: { key: "src", title: "ספר", origin: "otzaria" as const }, lines: [{ index: 0, text: 'מחייב [יבמות פ"ז ע"ב], וכתבו בתוס\' [ד"ה רבי מאיר] דלא', heading: null }] };
    const r = runCitationsEngine(src, lib);
    // without the commentary's text: its amud (its first line — a Sefaria book takes no range, B1)
    expect(r.suggestions.map((s) => [s.target.book.key, s.target.line, s.confidence])).toEqual([
      ["yev", 1, "certain"],
      ["tos-yev", 1, "high"],
    ]);
    // with it: the line whose heading is the ד"ה
    const text = ["", "<b>אמר רבא.</b> פירוש", "<b>ר' מאיר מחייב.</b> וקשה", "<b>רבי מאיר מחייב.</b> וקשה"];
    const lines = (t: string[]) => (b: { key: string }, from: number, to: number) => (b.key === "tos-yev" ? t.map((x, index) => ({ index, text: x })).slice(from, to + 1) : []);
    const tos3: RefLine[] = [...tos, { index: 3, heRef: "תוספות על יבמות, פז:, ג, א" }];
    const lib3 = { ...lib, index: (b: { key: string; title: string; origin: BookOrigin }) => buildRefIndex(b, b.key === "yev" ? yev : tos3) };
    const d = runCitationsEngine(src, { ...lib3, lines: lines(text) }).suggestions.find((s) => s.target.book.key === "tos-yev")!;
    expect(d.target.line).toBe(3);
    expect(d.rules).toContain("citations.dibur-line");
    // two lines open with the words: the amud stays
    const twice = runCitationsEngine(src, { ...lib3, lines: lines(["", "<b>רבי מאיר.</b> א", "<b>רבי מאיר.</b> ב", "ג"]) });
    expect(twice.suggestions.find((s) => s.target.book.key === "tos-yev")!.rules).not.toContain("citations.dibur-line");
  });
});

function gem(n: number): string {
  const ones = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
  const tens = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
  if (n === 15) return "טו";
  if (n === 16) return "טז";
  return tens[Math.floor(n / 10)]! + ones[n % 10]!;
  // (dafim up to 61 in these fixtures)
}
