import { describe, expect, it } from "vitest";
import type { BookOrigin, BookRef } from "../../../../src/core/links/model";
import type { EngineBook } from "../../../../src/linking/automatic";
import { AliasIndex, buildRefIndex, CitationScanner, NamedUnitIndex, runCitationsEngine, type CatalogBook, type Citation, type RefLine } from "../../../../src/linking/automatic/citations";

/*
 * The citation forms of the fourth round on the library benchmark's misses (docs/validation/LIBRARY_BENCHMARK.md
 * §6.2; docs/AUTOMATION_ENGINE.md §6.3): the real strings the database anchors its LINKER links on, and the
 * negatives each rule must keep. Titles are the library's own (seforim.db).
 */
const book = (key: string, title: string, origin: BookOrigin = "sefaria", aliases: string[] = []): CatalogBook => ({ book: { key, title, origin }, aliases });
const CATALOG: CatalogBook[] = [
  book("sam1", "שמואל א"),
  book("kings1", "מלכים א"),
  book("song", "שיר השירים"),
  book("ber", "ברכות"),
  book("kid", "קידושין"),
  book("bm", "בבא מציעא", "sefaria", ['ב"מ']),
  book("az", "עבודה זרה", "sefaria", ['ע"ז']),
  book("zev", "זבחים"),
  book("san", "סנהדרין"),
  book("beitza", "ביצה"),
  book("m-san", "משנה סנהדרין"),
  book("m-az", "משנה עבודה זרה"),
  book("y-san", "תלמוד ירושלמי סנהדרין"),
  book("y-hor", "תלמוד ירושלמי הוריות", "sefaria", ["ירוש'"]),
  book("tos-kid", "תוספות על קידושין"),
  book("tos-az", "תוספות על עבודה זרה"),
  book("tos-zev", "תוספות על זבחים"),
  book("tos-beitza", "תוספות על ביצה"),
  book("tyt-az", "תוספות יום טוב על משנה עבודה זרה"),
  book("rosh-kid", 'פסקי הרא"ש על קידושין'),
  book("r-korban", "משנה תורה, הלכות מעשה הקרבנות"),
  book("r-pesach", "משנה תורה, הלכות קרבן פסח"),
  book("r-ned", "משנה תורה, הלכות נדרים"),
  book("km-pesach", "כסף משנה על משנה תורה, הלכות קרבן פסח"),
  book("km-ned", "כסף משנה על משנה תורה, הלכות נדרים"),
  book("sa-oc", "שולחן ערוך, אורח חיים"),
  book("ma", "מגן אברהם", "sefaria", ['מג"א']),
  book("bs", "בית שמואל", "sefaria", ['ב"ש']),
  book("gen", "בראשית"),
  book("ex", "שמות"),
  book("lev", "ויקרא"),
  book("deut", "דברים"),
  book("ps", "תהילים"),
  book("m-okt", "משנה עוקצים"),
  book("mid-ps", "מדרש תהילים"),
  book("mkesef", "משנה כסף"),
  book("rashi-deut", 'רש"י על דברים'),
  book("rashi-gen", 'רש"י על בראשית'),
  book("malbim-ps", 'מלבי"ם על תהילים'),
  book("bech", "בכורות"),
  book("ket", "כתובות"),
  book("tos-bech", "תוספות על בכורות"),
  book("ned", "נדרים"),
  book("bb", "בבא בתרא", "sefaria", ['ב"ב']),
  book("m-bb", "משנה בבא בתרא"),
  book("r-az", "משנה תורה, הלכות עבודה זרה וחוקות הגויים"),
  book("rashi-kid", 'רש"י על קידושין'),
  book("rashi-bm", 'רש"י על בבא מציעא'),
  book("hul", "חולין"),
  book("tos-hul", "תוספות על חולין", "sefaria", ["תוס' חולין"]),
  book("ptos-hul", "פסקי תוספות על חולין", "sefaria", ["תוס' חולין"]),
  book("tsfta-hul", "תוספתא חולין", "sefaria", ["תוס' חולין"]),
  book("tos-san", "תוספות על סנהדרין"),
  book("tif", "תפארת ישראל", "otzaria"),
];

function scan(lines: (string | [string, string])[], sourceTitle = "ספר כלשהו"): Citation[] {
  const sc = new CitationScanner(AliasIndex.build(CATALOG), "src", {}, sourceTitle, NamedUnitIndex.build([]));
  lines.forEach((l, n) => (Array.isArray(l) ? sc.scanLine(n, l[0], null, l[1]) : sc.scanLine(n, l, null)));
  return sc.citations;
}
const books = (c: Citation | undefined) => c?.candidates.map((x) => x.book.key) ?? [];
const loc = (c: Citation | undefined) => c?.elems.map((e) => `${e.kind}:${e.n}${e.amud ? (e.amud === 1 ? "a" : "b") : ""}`).join(" ") ?? "";

describe("a daf and its amud as books write them", () => {
  it('"קידושין לט, ב." — the period after the amud letter ends the sentence', () => {
    const [c] = scan(["דשכר מצוה בהאי עלמא ליכא: ראה קידושין לט, ב."]);
    expect(books(c)).toEqual(["kid"]);
    expect(loc(c)).toBe("?:39 ?:2");
    expect(loc(scan(["אכל בי עשרה שכינתא שריא: סנהדרין לט, א. וראה"])[0])).toBe("?:39 ?:1");
    // "כג." glued to a numeral is still amud א
    expect(loc(scan(["ראה קידושין כג. ושם"])[0])).toBe("daf:23a");
  });
  it('15 and 16 written "י"ה", "י"ו" — only after a marker word', () => {
    expect(loc(scan(['ובקדושין דף י"ו ע"ב (תוד"ה והא) יעו"ש'])[0])).toBe("daf:16b");
    // "י"ה" alone is the divine name, not 15
    expect(scan(['ברכות י"ה אמר'])).toHaveLength(0);
  });
  it('"ובב"מ צו ב," — an everyday word as the daf, with a lone amud letter that ends the words', () => {
    const [c] = scan(['ראשונים רבים כאן ובב"מ צו ב, שבהלכה']);
    expect(books(c)).toEqual(["bm"]);
    expect(loc(c)).toBe("?:96 ?:2");
    // the letter is the start of running words: no place
    expect(scan(['ראשונים רבים כאן ובב"מ צו ב אמרו'])).toHaveLength(0);
  });
  it('"ע"ז כ"ו א\'": a tractate whose name is a numeral, with a lone amud letter', () => {
    const [c] = scan(["ועיין ע\"ז כ\"ו א' ושם"]);
    expect(books(c)).toContain("az");
    expect(loc(c)).toBe("?:26 ?:1");
    // with no amud, the numeral name is no tractate
    expect(scan(['ועיין ע"ז כ"ו ושם'])).toHaveLength(0);
  });
});

describe("a commentator after the place, and its ד\"ה", () => {
  it('"זבחים מ"ו ב\' תוד"ה אבל": the commentator\'s word is the ד"ה', () => {
    const [c] = scan(["ועיין זבחים מ\"ו ב' תוד\"ה אבל שכ' דלא"]);
    expect(books(c)).toEqual(["tos-zev"]);
    expect(c!.dh).toEqual(["אבל", "שכ", "דלא"]);
  });
  it('"(תוד"ה והא)" in a bracket after the place', () => {
    const [c] = scan(['וכמ"ש ובקדושין דף י"ו ע"ב (תוד"ה והא) יעו"ש.']);
    expect(books(c)).toEqual(["tos-kid"]);
    expect(c!.dh?.[0]).toBe("והא");
    // in a bracket of its own, with no ד"ה, the commentator does not move the place: "(תוס' שם)" is his own
    // citation (commentator-ibid), "(ותוס' חולקים)" a comparison
    expect(scan(['ובקדושין דף י"ו ע"ב (תוס\' שם) יעו"ש']).map(books)).toEqual([["kid"], ["tos-kid"]]);
    expect(books(scan(['ובקדושין דף י"ו ע"ב (ותוס\' חולקים)'])[0])).toEqual(["kid"]);
  });
  it('"התוס\' ע"ז כ"ו א\' ד"ה … ושם ע"ב ד"ה אני": the other amud of a daf written with a letter', () => {
    const cs = scan(["ודלא כדברי התוס' ע\"ז כ\"ו א' ד\"ה והרועים ושם ע\"ב ד\"ה אני שמצוה"]);
    expect(cs.map(books)).toEqual([["tos-az"], ["tos-az"]]);
    expect(cs[1]!.rule).toBe("ibid-amud");
    expect(loc(cs[1])).toBe("daf:26b");
  });
  it('"תוס\'" is תוספות on the Gemara, not תוספות יום טוב on the Mishna of the same tractate', () => {
    const [c] = scan(['כמו שכתבו התוס\' בפ"ב דע"ז']);
    expect(books(c)).toEqual(["tos-az"]);
  });
  it('"התוס\' בסוף פ"א דביצה": a word for where in the chapter between the commentator and the chapter', () => {
    const [c] = scan(["וכן לשיטת התוס' בסוף פ\"א דביצה וביומא"]);
    expect(books(c)).toEqual(["tos-beitza"]);
    expect(c!.commentator).toBe("תוספות");
  });
});

describe("books of the Tanakh by a short name, in brackets", () => {
  it('"(ש"א ט"ו)", "(מ"א ב)": a chapter alone', () => {
    const [c] = scan(['כמו שבאה לשאול (ש"א ט"ו) למחות']);
    expect(books(c)).toEqual(["sam1"]);
    expect(loc(c)).toBe("?:15");
    expect(books(scan(['וישם דמי מלחמה בשלום (מ"א ב), והטעם'])[0])).toEqual(["kings1"]);
    // an everyday word as the chapter, or no bracket: nothing
    expect(scan(['כמו שבאה (ש"א לא) למחות'])).toHaveLength(0);
    expect(scan(['כמו שבאה ש"א ט"ו למחות'])).toHaveLength(0);
  });
  it('"(שיר ד\')" is שיר השירים — only in that shape', () => {
    const [c] = scan(["הדא הוא דכתיב (שיר ד') אתי מלבנון כלה"]);
    expect(books(c)).toEqual(["song"]);
    expect(loc(c)).toBe("?:4");
    expect(scan(["ואמר שיר ד' פעמים"])).toHaveLength(0);
    expect(scan(["ואמר (שיר חדש) לה'"])).toHaveLength(0);
  });
});

describe("the Rambam and its commentaries", () => {
  it('"הרמב"ם מעשה"ק י ה": a topic, then a chapter and a halacha as two bare numbers', () => {
    const [c] = scan(['וכ"פ הרמב"ם מעשה"ק י ה ובכורים']);
    expect(books(c)).toEqual(["r-korban"]);
    expect(loc(c)).toBe("?:10 ?:5");
    // one number is no place
    expect(scan(['וכ"פ הרמב"ם מעשה"ק י ובכורים'])).toHaveLength(0);
  });
  it('"בכסף משנה פ"ג דנדרים", "כ"מ פ"ה מק"פ": the commentary named before a reversed citation of the Rambam', () => {
    expect(books(scan(['ועיין מ"ש על זה בכסף משנה פ"ג דנדרים ובטור'])[0])).toEqual(["km-ned"]);
    const [c] = scan(["ועיי' כ\"מ פ\"ה מק\"פ הלכה ו' מייתי"]);
    expect(books(c)).toEqual(["km-pesach"]);
    expect(loc(c)).toBe("perek:5 halacha:6");
    // "וכ"מ" is "וכן משמע": the Rambam itself
    expect(books(scan(["וכ\"מ פ\"ה מהל' ק\"פ הלכה ו'"])[0])).toEqual(["r-pesach"]);
  });
});

describe("the Rambam's topics by their old names", () => {
  it(`"בפרק י' מהל' ע"ג", "פ"ב מהל' עכו"ם": עבודה זרה וחוקות הגויים`, () => {
    expect(books(scan([`וגם פוסק בפרק י' מהל' ע"ג דברים ככתבן`])[0])).toEqual(["r-az"]);
    expect(books(scan([`כמבואר בפ"ב מהל' עבודת כוכבים`])[0])).toEqual(["r-az"]);
    // "פ"ב דע"ז" is still the tractate
    expect(books(scan([`כמבואר בפ"ב דע"ז`])[0])).not.toContain("r-az");
  });
});

describe("chapters by number", () => {
  it('"הרא"ש קידושין ספ"ב": the end of a chapter, in the Rosh\'s work', () => {
    const [c] = scan(['וכמ"ש הרא"ש קידושין ספ"ב וצ"ע']);
    expect(books(c)).toEqual(["rosh-kid"]);
    expect(loc(c)).toBe("perek:2");
  });
  it('"בפ"ב דמסכת ע"ז": the word "מסכת" between the ד and the name', () => {
    expect(books(scan(['דמורייסא בפ"ב דמסכת ע"ז וזה'])[0])).toEqual(["az", "m-az"]);
  });
  it('"בירוש\' פ"ק דסנהד\'": "ירוש\'" is the word for the Yerushalmi, and a tractate cut short with a geresh', () => {
    const [c] = scan(["בירוש' פ\"ק דסנהד' מפרש"]);
    expect(books(c)).toContain("y-san");
    expect(books(c)).not.toContain("y-hor");
    expect(c!.qualifier).toBe("yerushalmi");
    // a truncation alone: the Bavli and the Mishna of the tractate
    expect(books(scan(["ראה פ\"ק דסנהד' מפרש"])[0])).toEqual(["san", "m-san"]);
  });
});

describe('a ס"ק with no siman', () => {
  it('"במג"א סק"א" in a commentary on the Shulchan Aruch: the siman of the citing line', () => {
    const [c] = scan([['נ"ב עיין במג"א סק"א שהביא', "חכמת שלמה על שולחן ערוך, אורח חיים, תמה, א"]], "חכמת שלמה על שולחן ערוך, אורח חיים");
    expect(books(c)).toEqual(["ma"]);
    expect(loc(c)).toBe("siman:445 sk:1");
    expect(c!.rule).toBe("sk-here");
    // in a book on something else, the siman is unknown
    expect(scan([['עיין במג"א סק"א שהביא', "ספר כלשהו, תמה, א"]])[0]!.rule).toBeUndefined();
  });
  it('not when the line named another siman, or "שם" stands by the name (לבושי שרד: the database points to that siman)', () => {
    const title = "לבושי שרד על שלחן ערוך אורח חיים";
    // the "שלחן" spelling is a commentary on the Shulchan Aruch too
    expect(scan([['כמש"כ המג"א סק"ה:', `${title}, רמז, ז`]], title)[0]!.rule).toBe("sk-here");
    // "(מ"א סק"א) עס"ג. היינו במג"א סק"ד ובסי' צ"ב סעיף ב' והוא שם במג"א סק"ב" (לבושי שרד, ט, ב)
    const cs = scan([['היינו ובסי\' צ"ב סעיף ב\' והוא שם במג"א סק"ב בשם הסמ"ג:', `${title}, ט, ב`]], title);
    expect(cs.some((c) => c.rule === "sk-here")).toBe(false);
    expect(scan([['כמ"ש המג"א שם סק"ג', `${title}, כה, ב`]], title).some((c) => c.rule === "sk-here")).toBe(false);
  });
});

describe('"שם" and a ס"ק after a siman', () => {
  it(`"רמ"א שם סעי' ב'" after "מג"א סי' ש"ו": the Shulchan Aruch at that siman, not the מג"א`, () => {
    const cs = scan([`כמ"ש מג"א סי' ש"ו סקט"ו וע"פי מ"ש רמ"א שם סעי' ב' באתרא`]);
    expect(cs.map(books)).toEqual([["ma"], ["sa-oc"]]);
    expect(loc(cs[1])).toBe("siman:306 seif:2");
    expect(cs[1]!.rule).toBe("rema-ibid");
    // without a seif after it, "רמ"א שם" is the Rema's words somewhere else: nothing (not the מג"א)
    expect(scan([`כמ"ש מג"א סי' ש"ו סקט"ו וכ"כ רמ"א שם בהגה`])).toHaveLength(1);
  });
  it(`"וב"ש סקכ"א" after "ב"ש סי' מ"ה": the same siman`, () => {
    const cs = scan([`כמ"ש מג"א סי' ש"ו סקט"ו וכ' מג"א סקכ"א`]);
    expect(loc(cs[1])).toBe("siman:306 sk:21");
    expect(cs[1]!.rule).toBe("sk-ibid");
    // another book's ס"ק is not in that siman
    const other = scan([`כמ"ש ב"ש סי' מ"ה וכ' מג"א סקכ"א`]);
    expect(other.map(books)).toEqual([["bs"], ["ma"]]);
    expect(other[1]!.rule).toBeUndefined();
  });
});

describe("a commentator and \"שם\"", () => {
  it(`"[רש"י שם]", "[התוס' (שם)]", "[ובר"ן שם]": his words on the place just cited — "full", at most "possible"`, () => {
    const cs = scan([`בכתוב ריש נצבים (דברים כ"ט, י"ח) "כי בשרירות לבי אלך", "במראות לבי" (רש"י שם), היינו`]);
    expect(cs.map(books)).toEqual([["deut"], ["rashi-deut"]]);
    expect(loc(cs[1])).toBe("?:29 ?:18");
    expect([cs[1]!.rule, cs[1]!.ibid]).toEqual(["commentator-ibid", "full"]);
  });
  it(`"תוס' שם ס"ה ע"ב": the daf written after "שם", in the tractate just cited`, () => {
    const cs = scan([`כמבואר בקידושין דף ס"ד ע"א (תוס' שם ס"ה ע"ב)`]);
    expect(cs.map(books)).toEqual([["kid"], ["tos-kid"]]);
    expect(loc(cs[1])).toBe("daf:65b");
    expect(cs[1]!.ibid).toBe("partial");
  });
  it("not after a citation that is no daf (Gemara) or chapter and verse (Tanakh), nor far from it", () => {
    expect(scan([`כמבואר בקידושין פ"ב (תוס' שם)`])).toHaveLength(1);
    expect(scan([`כמבואר בקידושין דף ס"ד ע"א`, ...Array.from({ length: 8 }, () => "טקסט"), `ותוס' שם כתבו`])).toHaveLength(1);
  });
});

describe("a daf as Chassidic and later books write it", () => {
  it(`"בנדרים דכ"ז": a ד glued to the daf after a tractate's name, with no amud`, () => {
    expect(loc(scan([`ועיין בנדרים דכ"ז שאמרו`])[0])).toBe("daf:27");
    // no tractate before it: no place
    expect(scan([`וכתב דכ"ז שאמרו`])).toHaveLength(0);
  });
  it(`"סע"א", "רע"ב" (the end / start of an amud) after a daf; elsewhere "סע"א" stays no amud`, () => {
    expect(loc(scan([`ועיין ע"ז ד סע"ב שאמרו`])[0])).toBe("daf:4b");
    expect(loc(scan([`פרק ב' דבבא בתרא (די"ט סע"א) אמרו`])[0])).toBe("perek:2 daf:19a");
    expect(scan([`ועיין או"ח ר"ז סע"א`]).flatMap((c) => c.elems.map((e) => e.kind))).not.toContain("daf");
  });
  it(`"ובגמרא (פרק חמישי דב"ב)": a word for the Gemara keeps the chapter out of the Mishna`, () => {
    expect(books(scan([`ובגמרא (פרק חמישי דב"ב) אמרו`])[0])).toEqual(["bb"]);
    expect(books(scan([`ובמשנה (פרק חמישי דב"ב) אמרו`])[0])).toContain("m-bb");
  });
});

describe("a daf in brackets across the headings of small sections", () => {
  it(`"(דף כ"ח)" in the ב"ח, a few lines after "בפ' המפלת (נדה דף כ"ט)" with "סעיף קטן" headings between`, () => {
    const sc = new CitationScanner(AliasIndex.build([...CATALOG, book("nida", "נדה")]), "src", {}, 'ב"ח', NamedUnitIndex.build([]));
    sc.scanLine(0, `ומאימתי מונין וכו' (נדה דף כ"ט) תנן יצא מחותך`, null);
    sc.scanLine(1, "סעיף קטן כז", 3);
    sc.scanLine(2, "ואפי' לא יצא לגמרי לחוץ וכו'", null);
    sc.scanLine(3, "סעיף קטן כח", 3);
    sc.scanLine(4, `זה נלמד ממימרא דרב הונא (דף כ"ח) שיתבאר בסמוך`, null);
    expect(sc.citations.map(books)).toEqual([["nida"], ["nida"]]);
    expect(sc.citations[1]!.rule).toBe("implicit-previous-far");
    // too far: nothing
    const far = new CitationScanner(AliasIndex.build([...CATALOG, book("nida", "נדה")]), "src", {}, 'ב"ח', NamedUnitIndex.build([]));
    far.scanLine(0, `ומאימתי מונין וכו' (נדה דף כ"ט) תנן`, null);
    far.scanLine(9, `זה נלמד ממימרא דרב הונא (דף כ"ח) שיתבאר`, null);
    expect(far.citations).toHaveLength(1);
  });
});

describe("a commentator on the Gemara, as notes write it", () => {
  it(`"ברש"י קידושין סוף ה.", "רש"י ב"מ קח.": "סוף"/"ריש" before a daf, and an everyday word as a daf with its side`, () => {
    expect(loc(scan([`עיין ברש"י קידושין סוף ה. שכתב`])[0])).toBe("daf:5a");
    expect(books(scan([`עיין ברש"י קידושין סוף ה. שכתב`])[0])).toEqual(["rashi-kid"]);
    expect(books(scan([`עיין רש"י ב"מ קח. שכתב`])[0])).toEqual(["rashi-bm"]);
    // "סוף" before a word: no place
    expect(scan([`עיין ברש"י קידושין סוף דבר`])).toHaveLength(0);
  });
  it(`"תוס' חולין ק"ט א'": a name that opens with "תוס'" is תוספות when the database gives it to several books`, () => {
    expect(books(scan([`עיין תוס' חולין ק"ט א' שכתבו`])[0])).toEqual(["tos-hul"]);
  });
  it(`"התוס' סנהדרין (נט רע"ב)": "רע"ב" after a commentary on a tractate`, () => {
    expect(loc(scan([`התוס' סנהדרין (נט רע"ב) כתבו`])[0])).toBe("daf:59b");
  });
  it(`"שם" is never the number 340`, () => {
    expect(loc(scan([`כמ"ש בתפארת ישראל פט"ז שם`])[0])).toBe("perek:16");
  });
  it(`"והב"י [או"ח סימן ג]": the part of a work on the Tur in a bracket after its name`, () => {
    const sc = new CitationScanner(AliasIndex.build([...CATALOG, book("by", "בית יוסף", "sefaria", ['ב"י'])]), "src", {}, "ספר כלשהו", NamedUnitIndex.build([]));
    sc.scanLine(0, `וכן כתב והב"י [או"ח סימן ג] בשם`, null);
    expect(sc.citations.map(books)).toEqual([["by"]]);
    expect(sc.citations[0]!.candidates[0]!.section).toBe("אורח חיים");
  });
  it(`"המג"א [או"ח סימן תלב ס"ק א]": a commentary on one part of the Shulchan Aruch, named before the part`, () => {
    const [c] = scan([`וכן כתב המג"א [או"ח סימן תלב ס"ק א] בשם`]);
    expect(books(c)).toEqual(["ma"]);
    expect(loc(c)).toBe("siman:432 sk:1");
  });
});

describe("commentators on the Tanakh", () => {
  it(`"רש"י (שם פסוק יט)": his words on another verse of the chapter just cited`, () => {
    const cs = scan([`כתיב (דברים כ"ט, י"ח) כי בשרירות, ועיין רש"י (שם פסוק יט) שכתב`]);
    expect(cs.map(books)).toEqual([["deut"], ["rashi-deut"]]);
    expect(loc(cs[1])).toBe("?:29 pasuk:19");
    expect(cs[1]!.ibid).toBe("partial");
  });
  it(`"והמלבי"ם [תהלים עח, נ]": a commentator by one word moves the verse to his commentary`, () => {
    expect(books(scan([`וכן כתב הגר"א והמלבי"ם [תהלים עח, נ], ואיוב`])[0])).toEqual(["malbim-ps"]);
  });
  it(`"(בראשית יב ה) … ופירש רש"י (ד"ה אשר)": his words on the verse just cited`, () => {
    const cs = scan([`כתיב (בראשית יב ה) ואת הנפש אשר עשו בחרן, ופירש רש"י (ד"ה אשר) דאברהם היה מגייר`]);
    expect(cs.map(books)).toEqual([["gen"], ["rashi-gen"]]);
    expect(loc(cs[1])).toBe("?:12 ?:5");
    expect(cs[1]!.dh?.[0]).toBe("אשר");
    // no verse just cited: nothing
    expect(scan([`ופירש רש"י (ד"ה אשר) דאברהם היה מגייר`])).toHaveLength(0);
  });
});

describe("a chapter by its name, then \"and in <another tractate>\"", () => {
  it(`"התוס' בס"פ יש בכור ובכתובות ר"פ אע"פ": "ובכתובות" opens the next citation`, () => {
    const units = NamedUnitIndex.build([
      { book: { key: "bech", title: "בכורות", origin: "sefaria" }, kind: "chapter", entries: [{ name: "על אלו מומין", line: 0 }, { name: "יש בכור לנחלה", line: 100 }], lastLine: 199 },
      { book: { key: "ket", title: "כתובות", origin: "sefaria" }, kind: "chapter", entries: [{ name: "בתולה נשאת", line: 0 }, { name: "אף על פי", line: 100 }], lastLine: 199 },
    ]);
    const sc = new CitationScanner(AliasIndex.build(CATALOG), "src", {}, "ספר כלשהו", units);
    sc.scanLine(0, `וכ"כ עוד התוס' בס"פ יש בכור ובכתובות ר"פ אע"פ`, null);
    expect(sc.citations.map(books)).toEqual([["tos-bech"], ["ket"]]);
  });
});

describe("the Tanakh as books write it in brackets", () => {
  it(`"(תה' נט)": a name that is also a numeral, with a chapter alone`, () => {
    const [c] = scan([`השיבנו (תה' נט) כי הכתוב`]);
    expect(books(c)).toEqual(["ps"]);
    expect(loc(c)).toBe("?:59");
    // not read as the number 405 of the place before it
    expect(c!.rule).toBeUndefined();
  });
  it(`"(ברא' יה א)": 15 written "יה" — only in brackets, with another number`, () => {
    expect(loc(scan([`וירא אליו ד' (ברא' יה א) גם`])[0])).toBe("?:15 ?:1");
    expect(scan([`וירא אליו ד' ברא' יה א גם`])).toHaveLength(0);
  });
  it(`"(ויקרא כו; דברים כח)": a list in brackets — each place its own citation`, () => {
    const cs = scan([`הכתובות בתורה (ויקרא כו; דברים כח) על`]);
    expect(cs.map(books)).toEqual([["lev"], ["deut"]]);
    expect(cs.map(loc)).toEqual(["?:26", "?:28"]);
  });
  it(`"(בראשית כא:לד; יב:י)": a ";" ends the place; "(שמות ז:ג-יב:לו)": a range into another chapter starts at its start`, () => {
    expect(loc(scan([`ובארץ כנען (בראשית כא:לד; יב:י) כולם`])[0])).toBe("?:21 ?:34");
    expect(loc(scan([`במצרים (שמות ז:ג-יב:לו):`])[0])).toBe("?:7 ?:3");
  });
  it(`"(עוקצין ג:ח)", "(שו"ט עה:א)": spellings of the Mishna's tractates and of מדרש תהילים`, () => {
    expect(books(scan([`בקליפה (עוקצין ג:ח):`])[0])).toEqual(["m-okt"]);
    expect(books(scan([`את ישראל (שו"ט עה:א):`])[0])).toEqual(["mid-ps"]);
  });
  it(`"משנה כסף" is a book, not a tractate of the Mishna named "כסף"`, () => {
    expect(scan([`ונתן לו כסף ב' זוזים`])).toHaveLength(0);
    expect(scan([`ונתן כסף ג, ד`])).toHaveLength(0);
  });
});

/* ---------- resolved (in memory) ---------- */

const ref = (key: string, title: string): BookRef => ({ key, title, origin: "sefaria" });
const BER = ref("ber", "ברכות");
const TOS_BER = ref("tos-ber", "תוספות על ברכות");
const M_BER = ref("m-ber", "משנה ברכות");
const g = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
/** a tractate (or a commentary on it) by daf: each amud a heading and three segments */
function dafRefs(title: string, dapim: number, deep = false): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  for (let d = 2; d <= dapim; d++)
    for (const side of [".", ":"]) {
      out.push({ index: out.length, heRef: null });
      for (let s = 1; s <= 3; s++) out.push({ index: out.length, heRef: `${title}, ${g[d]}${side}, ${g[s]}${deep ? ", א" : ""}` });
    }
  return out;
}
function mishnaRefs(title: string, chapters: number): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  for (let c = 1; c <= chapters; c++) for (let m = 1; m <= 3; m++) out.push({ index: out.length, heRef: `${title}, ${g[c]}, ${g[m]}` });
  return out;
}
const REFS: Record<string, RefLine[]> = { ber: dafRefs("ברכות", 6), "tos-ber": dafRefs("תוספות על ברכות", 6, true), "m-ber": mishnaRefs("משנה ברכות", 3) };
// chapter 1 is dafim ב–ג (lines 1–16), chapter 2 from daf ד (line 17)
const UNITS = [
  { book: BER, kind: "chapter" as const, entries: [{ name: "מאימתי", line: 1 }, { name: "היה קורא", line: 17 }], lastLine: 40 },
  { book: TOS_BER, kind: "chapter" as const, entries: [{ name: "מאימתי", line: 1 }, { name: "היה קורא", line: 17 }], lastLine: 40 },
];
const source = (lines: string[]): EngineBook => ({ book: { key: "src", title: "חיבור כלשהו", origin: "otzaria" }, lines: lines.map((text, index) => ({ index, text, heading: null })) });
const run = (line: string) =>
  runCitationsEngine(source([line]), {
    catalog: [BER, TOS_BER, M_BER].map((b) => ({ book: b })),
    units: UNITS,
    index: (b) => buildRefIndex(b, REFS[b.key]!),
  }).suggestions;

describe("a chapter by number in a book by daf", () => {
  it('"תוס\' פ"ב דברכות": the commentary\'s whole second chapter, by its own structure — "possible"', () => {
    const [s] = run('אבל תוס\' פ"ב דברכות כתבו');
    expect(s!.target.book.key).toBe("tos-ber");
    expect(s!.target.line).toBe(17);
    expect(s!.confidence).toBe("possible");
  });
  it('"בש"ס פ"ב דברכות": the Gemara\'s chapter, not the Mishna\'s', () => {
    const out = run('והכי מוכח בש"ס פ"ב דברכות גבי הא');
    expect(out[0]!.target.book.key).toBe("ber");
    expect(out[0]!.target.line).toBe(17);
  });
  it(`"תוס' ברכות פ"ב" after the name is chapter 2 or daf 82: no chapter guessed`, () => {
    expect(run(`אבל תוס' ברכות פ"ב כתבו`).filter((s) => s.target.book.key === "tos-ber" && s.target.line === 17)).toHaveLength(0);
    // "ספ"ב" can only be a chapter's end
    expect(run(`אבל תוס' ברכות ספ"ב כתבו`)[0]!.target.line).toBe(17);
  });
  it('"פ"ב דברכות" with no word for the Gemara stays the Mishna\'s chapter', () => {
    const out = run('והכי מוכח פ"ב דברכות גבי הא');
    expect(out.map((s) => s.target.book.key)).toEqual(["m-ber"]);
  });
});

describe('"רמ"א שם" resolved', () => {
  it("links the Shulchan Aruch at the siman of the commentary just cited — another book than the one before it", () => {
    const SA = ref("sa-oc", "שולחן ערוך, אורח חיים");
    const MA = ref("ma", "מגן אברהם");
    const twoLevels = (title: string): RefLine[] => {
      const out: RefLine[] = [{ index: 0, heRef: null }];
      for (let a = 1; a <= 3; a++) for (let b = 1; b <= 3; b++) out.push({ index: out.length, heRef: `${title}, ${g[a]}, ${g[b]}` });
      return out;
    };
    const refs: Record<string, RefLine[]> = { "sa-oc": twoLevels("שולחן ערוך, אורח חיים"), ma: twoLevels("מגן אברהם") };
    const out = runCitationsEngine(source([`כמ"ש מג"א סי' ב' סק"א וע"פי מ"ש רמ"א שם סעי' ג' באתרא`]), {
      catalog: [{ book: SA }, { book: MA, aliases: ['מג"א'] }],
      index: (b) => buildRefIndex(b, refs[b.key]!),
    }).suggestions;
    expect(out.map((s) => `${s.target.book.key}:${s.target.line}`)).toEqual(["ma:4", "sa-oc:6"]);
  });
});

describe("a chapter by an ordinal word", () => {
  it(`"בפרק קמא דבבא בתרא", "ברכות פרק בתרא דף נ"ו": the Gemara's — books mean its discussion there`, () => {
    expect(books(scan([`כדאיתא בפרק קמא דבבא בתרא שאמרו`])[0])).toEqual(["bb"]);
    expect(loc(scan([`כדאיתא ברכות פרק בתרא דף נ"ו שאמרו`])[0])).toBe("perek:0 daf:56");
    // with a word for the Mishna it stays there
    expect(books(scan([`כדתנן במשנה בפרק קמא דבבא בתרא`])[0])).toContain("m-bb");
  });
  it(`"בפרק בתרא דברכות", "במסכת ברכות פרק בתרא": the book's last chapter`, () => {
    for (const line of [`כדאיתא בפרק בתרא דברכות שאמרו`, `כדאיתא במסכת ברכות פרק בתרא שאמרו`]) {
      const [s] = run(line);
      expect(s?.target.book.key, line).toBe("ber");
      expect(s!.target.line, line).toBe(17);
    }
  });
});

describe("no hang", () => {
  it("punctuation that opens twice after a place (a loop that never advanced, found on אוצר לעזי רש\"י)", () => {
    expect(scan([`ראה (גיטין סט:) ([ובתוך]) וכו'`, `(ר' פירוש רש"י גיטין סט:) [(x)] ✭ [decorative]`])).toBeDefined();
  });
});
