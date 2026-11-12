import { describe, expect, it } from "vitest";
import type { BookOrigin } from "../../../../src/core/links/model";
import { AliasIndex, CitationScanner, mergeIbid, type Citation } from "../../../../src/linking/automatic/citations";

/*
 * Citation detection on lines written the way the library writes them (the spans are taken from
 * LINKER anchors of the official seforim.db, see docs/AUTOMATION_ENGINE.md §6). Titles are the
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

describe("citations: guards found on the real library (docs/AUTOMATION_ENGINE.md §6.8)", () => {
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

describe("citations: a bare siman in a commentary on the Shulchan Aruch", () => {
  const mb = (line: string) => scan([line], "משנה ברורה", "mb");
  it("is a siman of the Shulchan Aruch part the commentary is on", () => {
    const c = mb('וכדלקמן בסימן ש"כ ס"א דהתם');
    expect(c).toHaveLength(1);
    expect(books(c[0]!)).toEqual(["sa-oc"]);
    expect(loc(c[0]!)).toBe("siman:320 seif:1");
  });
  it("unless another book is named next to it, or the location is a ס\"ק", () => {
    expect(mb('ואם צריך עמידה, עיין בסימן מ"ח במ"ב סק"א')).toHaveLength(0);
    expect(mb('ובמ"א סימן ז\' סתר דבריו')).toHaveLength(0);
    expect(mb('עיין לעיל סימן ג ס"ק ד')).toHaveLength(0);
    expect(scan(['עיין בסימן ש"כ ס"א'], "ספר כלשהו")).toHaveLength(0); // no base: a siman of the book itself
  });
});

describe("citations: a bare siman next to another book's name", () => {
  const mb = (line: string) => scan([line], "משנה ברורה", "mb");
  it("is that book's siman, not the base's", () => {
    expect(mb('אבל כבר כתב הט"ז לקמן בסימן ח\' דבזמנינו')).toHaveLength(0);
    expect(mb('כתב רש"ל בתשובה סימן צ"ז מי שאכל')).toHaveLength(0);
    expect(mb('וכמ"ש בסימן רצ"ו ס"ב וקידוש')).toHaveLength(1);
  });
});

describe("citations: a Rambam topic after a chapter (\"רמב\"ם פ\"ט מתרומות\")", () => {
  // the library's titles; "איגרות הרמב"ם" carries the author's name as its book_acronym, "משנה מעשר שני" carries "מ"ש"
  const RAMBAM = [
    ...CATALOG,
    book("r-trum", "משנה תורה, הלכות תרומות"),
    book("r-ib", "משנה תורה, הלכות איסורי ביאה"),
    book("r-gz", "משנה תורה, הלכות גזילה ואבידה"),
    book("r-ish", "משנה תורה, הלכות אישות"),
    book("r-mech", "משנה תורה, הלכות מכירה"),
    book("r-gir", "משנה תורה, הלכות גירושין"),
    book("r-maas", "משנה תורה, הלכות מעשרות"),
    book("r-ms", "משנה תורה, הלכות מעשר שני ונטע רבעי"),
    book("m-trum", "משנה תרומות"),
    book("m-ms", "משנה מעשר שני", "sefaria", ['מ"ש']),
    book("ket", "כתובות"),
    book("igrot", 'איגרות הרמב"ם', "otzaria", ['הרמב"ם']),
    book("sa-eh", "שולחן ערוך, אבן העזר"),
  ];
  const scanR = (line: string): Citation[] => {
    const sc = new CitationScanner(AliasIndex.build(RAMBAM), "src", {}, "ספר כלשהו");
    sc.scanLine(0, line, null);
    return sc.citations;
  };
  const oneR = (line: string) => {
    const c = scanR(line);
    expect(c, line).toHaveLength(1);
    return c[0]!;
  };

  it("the author's name before it, or a word for הלכות, makes the words a topic of the Rambam", () => {
    const a = oneR('כמ"ש רמב"ם פ"ט מתרומות הל\' ה\' ורמז');
    expect(books(a)).toEqual(["r-trum"]);
    expect(loc(a)).toBe("perek:9 halacha:5");
    expect(a.rule).toBe("rambam-topic-full");
    expect(books(oneR('וכן בפ"ה מה\' מכירה ע"ש'))).toEqual(["r-mech"]);
    expect(loc(oneR("ובפרק ו' מהלכו' אישות כתב"))).toBe("perek:6");
    // "רפ"י" = ריש פרק י
    expect(loc(oneR('ושיטת רמב"ם רפ"י מגירושין וכבר'))).toBe("perek:10");
  });

  it("the first word of a topic, or its initials, when only one topic fits", () => {
    const g = oneR("ובפ' ט' מהל' גזלה כתב");
    expect(books(g)).toEqual(["r-gz"]);
    expect(g.rule).toBe("rambam-topic-first");
    const i = oneR('הרמב"ם פ"ג מא"ב הלכה ב\' אבל');
    expect(books(i)).toEqual(["r-ib"]);
    expect(i.rule).toBe("rambam-topic-initials");
    // "מעשר" is the first word of מעשר שני and the start of מעשרות: no guess
    expect(scanR('כמ"ש רמב"ם סוף פ\' י"ב מהל\' מעשר והכא')).toHaveLength(0);
  });

  it("the author's name is not a book: it does not swallow the place", () => {
    expect(scanR('וזהו דעת הרמב"ם פ"ד מהל\' תרומות ע"ש').map(books)).toEqual([["r-trum"]]);
  });

  it("without the author or הלכות the words are the tractate; with the author, a tractate is not guessed", () => {
    expect(books(oneR('וכדתנן פ"ט מתרומות'))).toEqual(["m-trum"]);
    expect(scanR('והרמב"ם פ"ב דכתובות כתב')).toHaveLength(0);
    // a chapter over 30 after ר/ס is not "ריש/סוף פרק"
    expect(scanR('ספ"ר דכתובות')).toHaveLength(0);
  });

  it("\"מ\"ש\" opens no citation (מה שכתב), but is the tractate after a chapter", () => {
    expect(books(oneR('כמ"ש באה"ע סי\' קמ"א ס"ל'))).toEqual(["sa-eh"]);
    expect(books(oneR('וכדאיתא בפ"ב דמ"ש ובירושלמי'))).toEqual(["m-ms"]);
  });
});

describe("citations: a daf as the library writes it (§6.2)", () => {
  const TALMUD = [...CATALOG, book("hul", "חולין"), book("men", "מנחות"), book("ket", "כתובות"), book("kid", "קידושין"), book("az", "עבודה זרה"), book("m-az", "משנה עבודה זרה")];
  const scanT = (lines: string[]): Citation[] => {
    const sc = new CitationScanner(AliasIndex.build(TALMUD), "src", {}, "ספר כלשהו");
    lines.forEach((l, i) => sc.scanLine(i, l, null));
    return sc.citations;
  };
  const oneT = (line: string) => {
    const c = scanT([line]);
    expect(c, line).toHaveLength(1);
    return c[0]!;
  };

  it("\"דף ע\"א\" / \"דף ע\"ב\" is daf 71 / 72; \"ד' ע\"א\" stays daf 4", () => {
    expect(loc(oneT('כמו שכתבו בחולין (דף ע"ב) שכתב'))).toBe("daf:72");
    expect(loc(oneT('ובב"ק דף ע"ב ע"ב וכן'))).toBe("daf:72b");
    expect(loc(oneT('בבבא קמא ד\' ע"א איתא'))).toBe("daf:4a");
  });

  it("a ד for \"דף\" glued to the number, before an amud", () => {
    expect(loc(oneT('ואמרו (מנחות דמ"ג ע"ב) ראיה'))).toBe("daf:43b");
    expect(loc(oneT('עיין בגמרא ברכות ד"ז ע"א וכו\''))).toBe("daf:7a");
    expect(scanT(['ואמרו מנחות דמ"ג ראיה'])).toHaveLength(0);
  });

  it("an amud after a comma; an amud makes even an everyday word a daf", () => {
    expect(loc(oneT('כי "החטא ממית" (ברכות ל"ג, ע"א). וכשאדם'))).toBe("daf:33a");
    expect(loc(oneT('ובקידושין ה\' ע"ב והרי'))).toBe("daf:5b");
    expect(scanT(["שמות ה' הם קדושים"])).toHaveLength(0);
  });

  it("the words after a daf with its amud are the quote, not more levels", () => {
    const a = oneT('[א.] שבת דף מ"ד ת"ר מותר השמן');
    expect(loc(a)).toBe("daf:44");
    expect(a.text).toBe('שבת דף מ"ד');
    expect(loc(oneT('ועיין יבמות ל"א ע"ב לא שייך'))).toBe("daf:31b");
  });

  it("a daf in brackets after a chapter; a \".\" before a closing bracket is the amud", () => {
    expect(loc(oneT("ואנן קיי\"ל בפ\"ב דכתובות (כ'.) דאין"))).toBe("perek:2 daf:20a");
    expect(loc(oneT("ומייתי לה במנחות פ\"ק (ז'.) אמר"))).toBe("perek:1 daf:7a");
    expect(loc(oneT('כמו שמצינו (שבת י"א.) באותן'))).toBe("daf:11a");
    expect(loc(oneT('כמו שמצינו שבת י"א. ואמר'))).toBe("?:11");
  });

  it("a tractate whose name is a numeral, with a daf and its amud; without the amud it is a number", () => {
    expect(books(oneT('ועי\' במס\' ע"ז נ"ב ע"א מאי'))).toContain("az");
    expect(scanT(['והוא ע"ז נ"ב שנה'])).toHaveLength(0);
  });

  it("\"בנזיר (שם)\": the book, at the last citation's place", () => {
    const c = scanT(["כדאיתא בשבת כג. ואמר", "ובשבת (שם) אמר"]);
    expect(c.map((x) => x.ibid)).toEqual(["none", "book"]);
    expect(loc(c[1]!)).toBe("daf:23a");
  });
});

describe("citations: \"(שם)\" after an author's name is that author's book", () => {
  it("past the bracket and ז\"ל; not after a running-text word", () => {
    const lines = (second: string) => scan(['כדאיתא בשבת כג. ואמר', second]);
    expect(lines('ובזה יתבאר מה שהקשה המ"ל (שם) ע"ז')).toHaveLength(1);
    expect(lines('והנה הרשב"א [שם] הקשה')).toHaveLength(1);
    expect(lines('לשונו של הרמב"ם ז"ל (שם) שכתב')).toHaveLength(1);
    expect(lines('וכתבו תוס\' (שם) דאיכא')).toHaveLength(1);
    // "וגו' (שם כז)", "קיי"ל (שם)", "הגמ' (שם)": the last citation
    expect(lines("ויקח משה וגו' (שם כד.) ואם")).toHaveLength(2);
    expect(lines('ואע"ג דקיי"ל (שם) אין')).toHaveLength(2);
    expect(lines("ועל זה מקשה הגמ' (שם) והא")).toHaveLength(2);
  });
});
