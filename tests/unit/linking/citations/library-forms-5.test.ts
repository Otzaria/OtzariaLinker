import { describe, expect, it } from "vitest";
import type { BookOrigin } from "../../../../src/core/links/model";
import { AliasIndex, CitationScanner, NamedUnitIndex, type CatalogBook, type Citation } from "../../../../src/linking/automatic/citations";
import { CHAPTER_OPENINGS, RAMBAM_TOPIC_NAMES } from "../../../../src/linking/automatic/citations/knowledge";

/*
 * The citation forms of the V5 round (16.11; docs/AUTOMATION_ENGINE.md §6.3ה): the lines are the library's own
 * (seforim.db, the book and the line index in each test's name), cut to the sentence of the citation. Each was a
 * LINKER link of the database the engine missed. Titles are the library's.
 */
const book = (key: string, title: string, origin: BookOrigin = "sefaria", aliases: string[] = []): CatalogBook => ({ book: { key, title, origin }, aliases });
const CATALOG: CatalogBook[] = [
  book("shab", "שבת"),
  book("eruv", "עירובין"),
  book("suk", "סוכה"),
  book("bech", "בכורות"),
  book("bb", "בבא בתרא", "sefaria", ['ב"ב']),
  book("git", "גיטין"),
  book("tos-shab", "תוספות על שבת"),
  book("tos-eruv", "תוספות על עירובין"),
  book("tos-bech", "תוספות על בכורות"),
  book("tos-bb", "תוספות על בבא בתרא"),
  book("tos-git", "תוספות על גיטין"),
  book("rashi-eruv", 'רש"י על עירובין'),
  book("r-mizbe", "משנה תורה, הלכות איסורי המזבח"),
  book("r-shmita", "משנה תורה, הלכות שמיטה ויובל"),
  book("r-shvuot", "משנה תורה, הלכות שבועות"),
  book("r-psulei", "משנה תורה, הלכות פסולי המוקדשין"),
  book("r-machus", "משנה תורה, הלכות מחוסרי כפרה"),
  book("r-korbanot", "משנה תורה, הלכות מעשה הקרבנות"),
  book("r-pesach", "משנה תורה, הלכות קרבן פסח"),
  book("r-maas", "משנה תורה, הלכות מעשרות"),
  book("r-ms", "משנה תורה, הלכות מעשר שני ונטע רבעי"),
  book("r-az", "משנה תורה, הלכות עבודה זרה וחוקות הגויים"),
  book("r-yh", "משנה תורה, הלכות עבודת יום הכפורים"),
  book("sa-oc", "שולחן ערוך, אורח חיים"),
  book("ma", "מגן אברהם", "sefaria", ['מג"א']),
  book("y-suk", "תלמוד ירושלמי סוכה"),
  book("y-bk", "תלמוד ירושלמי בבא קמא"),
  book("y-peah", "תלמוד ירושלמי פאה"),
  book("y-ber", "תלמוד ירושלמי ברכות"),
  book("m-ber", "משנה ברכות"),
  book("m-suk", "משנה סוכה"),
  book("bk", "בבא קמא", "sefaria", ['ב"ק']),
  book("ber", "ברכות"),
];

function scan(lines: string[], sourceTitle = "ספר כלשהו"): Citation[] {
  const sc = new CitationScanner(AliasIndex.build(CATALOG), "src", {}, sourceTitle, NamedUnitIndex.build([]));
  lines.forEach((l, n) => sc.scanLine(n, l, null));
  return sc.citations;
}
const books = (c: Citation | undefined) => c?.candidates.map((x) => x.book.key) ?? [];
const loc = (c: Citation | undefined) => c?.elems.map((e) => `${e.kind}:${e.n}${e.amud ? (e.amud === 1 ? "a" : "b") : ""}`).join(" ") ?? "";

describe("the Rambam's topics as books write them (knowledge/rambam-topics.json)", () => {
  it("the names are data mined from the database's citations, each with its evidence", () => {
    expect(RAMBAM_TOPIC_NAMES.length).toBeGreaterThan(20);
    for (const n of RAMBAM_TOPIC_NAMES) expect(n.linker).toBeGreaterThanOrEqual(3);
  });
  it('"שביעית" is שמיטה ויובל, not שבועות (שו"ת שבט הלוי חלק ז, line 2571: "ופסקה הרמב"ם פ"ה דשביעית")', () => {
    const [c] = scan(['כגון פת שעיפשה ולא קניבת ירק ופסקה הרמב"ם פ"ה דשביעית.']);
    expect(books(c)).toEqual(["r-shmita"]);
    expect(c!.rule).toBe("rambam-topic-known");
    // ורמב"ם הל' שביעית פ"ט ה"ט (line 3047): "רמב"ם", a word for hilchot, the topic, the chapter
    const [d] = scan(['ובחו"מ סי\' ס"ז, ורמב"ם הל\' שביעית פ"ט ה"ט.']);
    expect(books(d)).toEqual(["r-shmita"]);
    expect(loc(d)).toBe("perek:9 halacha:9");
  });
  it('"איסורי מזבח" without the article (שבט הלוי, line 669; חידושי חתם סופר על גיטין, line 886: "פ"ה מאי\' מזבח")', () => {
    expect(books(scan(['ולענין אין פודין הדברים בהיפך וברמב"ם פ"ו מאיסורי מזבח ה"ד כ\' טעם'])[0])).toEqual(["r-mizbe"]);
    expect(books(scan(['ומיושב לשון הרמב"ם פ"ה מאי\' מזבח הלכה ז\' שהשיג הראב"ד'])[0])).toEqual(["r-mizbe"]);
  });
  it('"פסוהמ"ק" is פסולי המוקדשין (יכין כריתות, line 611) — and LINKER\'s own error "פסהמ"ק" → מחוסרי כפרה is not taught', () => {
    expect(books(scan(["וישרף ככל חטאת העוף הבא על הספק [כרמב\"ם פ\"ז מפסוהמ\"ק], ויהיה"])[0])).toEqual(["r-psulei"]);
    expect(RAMBAM_TOPIC_NAMES.some((n) => n.written === 'פסהמ"ק' && n.topic === "מחוסרי כפרה")).toBe(false);
  });
  it('a word for hilchot, the topic as books abbreviate it, then the chapter (תקנת עזרא, line 54: "עיין בהל\' מעשה"ק (פ"ב הי"ב)")', () => {
    const [c] = scan(['ודעת רבינו בעינן זה צ"ע עיין בהל\' מעשה"ק (פ"ב הי"ב) ובה\' פסוהמו"ק (פי"ב הט"ו)']);
    expect(books(c)).toEqual(["r-korbanot"]);
    expect(loc(c)).toBe("perek:2 halacha:12");
    expect(c!.rule).toMatch(/^rambam-hilchot-/);
    // without a chapter after it, no place: "בהל' שבת" alone is no citation
    expect(scan(["כמבואר בהל' מעשה\"ק ע\"ש"])).toHaveLength(0);
  });
  it('"עבודת כוכבים" is עבודה זרה, not "עבודת" יום הכפורים', () => {
    expect(books(scan(['עיין רמב"ם פ"א מהל\' עבודת כוכבים ה"ב'])[0])).toEqual(["r-az"]);
  });
});

describe("a daf with no tractate, told by the citation before it", () => {
  it('"בגמרא בדף ל"ה ע"ב" after "בסוכה בדף ל"ד" in the same line (נפש חיה אורח חיים, line 109)', () => {
    const cs = scan(['וכונתו על מאי דאיתא בסוכה בדף ל"ד במשנה נטלם פטמתו פסול ואח"כ אמר נטל עוקצו כשר ואיתא שם בגמרא בדף ל"ה ע"ב תני ר\' יצחק']);
    expect(books(cs[0])).toContain("suk");
    expect(books(cs[1])).toEqual(["suk"]);
    expect(cs[1]!.rule).toBe("context-daf");
    expect(loc(cs[1])).toBe("daf:35b");
  });
  it('"מדברי הגמ\' בדף ע"ג" the line after "בשבת בדף ע"ג" (נפש חיה אורח חיים, lines 308–309)', () => {
    const cs = scan(['אך עדיין הקשה דבשבת בדף ע"ג אית\' דנתכוין להגבי\' את התלוש', 'וגם מה שהביא מדברי הגמ\' בדף ע"ג דאית\' פטור אבל אסור']);
    expect(cs.map(books)).toEqual([["shab"], ["shab"]]);
    expect(cs[1]!.rule).toBe("context-daf");
  });
  it('"כאשר פי\' רש"י בדף פ"ט" after a daf of עירובין: Rashi on it (נפש חיה אורח חיים, line 709)', () => {
    const cs = scan(['הנה בעירובין בדף פ"ט איתא', 'ודבריו צ"ע כאשר פי\' רש"י בדף פ"ט במחיצות הניכרות']);
    expect(books(cs[1])).toEqual(["rashi-eruv"]);
    expect(cs[1]!.commentator).toBe('רש"י');
  });
  it("not two lines after, not when another book is named between, not after a name we do not know", () => {
    expect(scan(["בשבת בדף ע\"ג", "שורה", "וגם בדף ע\"ה"]).map(books)).toEqual([["shab"]]);
    expect(scan(['בשבת בדף ע"ג ובגיטין כתב וגם בדף ע"ה']).map((c) => c.rule ?? "")).not.toContain("context-daf");
    expect(scan(['בשבת בדף ע"ג ובמהרש"א בדף ע"ה']).map(books)).toEqual([["shab"]]);
  });
});

describe("a commentator's ד\"ה — more of the ways books write it", () => {
  it('"התוספת" before a ד"ה (צפנת פענח, line 1748: "וכתבו התוספת (ד"ה לימא)" after "דף ט\' ע"ב")', () => {
    const cs = scan(['בשבת דף ט\' ע"ב: סמוך למנחה קטנה, וכתבו התוספת (ד"ה לימא) מדקאמר']);
    expect(cs.map(books)).toEqual([["shab"], ["tos-shab"]]);
    expect(cs[1]!.dh?.[0]).toBe("לימא");
    // "תוספת" with no ד"ה is a word: "ותוספת שבת (שבת ט:)" is the Gemara
    expect(scan(["ותוספת שבת (שבת ט:) ע\"ש"]).map(books)).toEqual([["shab"]]);
  });
  it('"בד\' ו\' ע"ב בד"ה" — "בד\'" is "בדף" before a numeral and a written amud (נפש חיה אורח חיים, line 1131)', () => {
    const [c] = scan(['יש לדמות זה לדברי התוס\' בעירובין בד\' ו\' ע"ב בד"ה והאמר רבה דכתבו']);
    expect(books(c)).toEqual(["tos-eruv"]);
    expect(loc(c)).toBe("daf:6b");
    expect(c!.dh?.[0]).toBe("והאמר");
    // "בד' אמות" stays "in four"
    expect(scan(["בעירובין בד' אמות"])).toHaveLength(0);
  });
  it('"ריש" before a chapter that a daf follows (מראה הפנים על תלמוד ירושלמי יבמות, line 61)', () => {
    const [c] = scan(['ועיין בתו\' לקמן דף ק"ה ובתוס\' בכורות ריש פ"ג דף י"ט ד"ה איש:']);
    expect(books(c)).toEqual(["tos-bech"]);
    expect(loc(c)).toBe("perek:3 daf:19");
  });
  it('the commentator before the chapter\'s words, the place and its ד"ה in a bracket (קובץ פרשיות ומועדים, line 98)', () => {
    const [c] = scan(['ובתוס\' ס"פ הספינה [ב"ב פ"ח ע"ב ד"ה התם] נראה שנחלקו']);
    expect(books(c)).toEqual(["tos-bb"]);
    expect(c!.dh?.[0]).toBe("התמ");
    // no ד"ה in the bracket: the Gemara
    expect(books(scan(['ובתוס\' ס"פ הספינה [ב"ב פ"ח ע"ב] נראה'])[0])).toEqual(["bb"]);
  });
  it('"והתוס\' סוף ד"ה וגובה" (חידושי חתם סופר על גיטין, line 53): the end of that ד"ה, on the daf of the context', () => {
    const cs = scan(['ובגיטין דף ג\' ע"ב', 'לרש"י בפי\' השני גובה בכל השטרות והתוס\' סוף ד"ה וגובה כ\'']);
    expect(books(cs[1])).toEqual(["tos-git"]);
    expect(cs[1]!.dh?.[0]).toBe("וגובה");
  });
});

describe("a ס\"ק of a commentary on the Shulchan Aruch", () => {
  it('the siman written before the commentator\'s name (שו"ת שבט הלוי חלק ז, line 412; מטה אפרים, line 42)', () => {
    const [c] = scan(['ועיין סי\' ר"ח במג"א ס"ק ז\' דצריך לברך']);
    expect(books(c)).toEqual(["ma"]);
    expect(loc(c)).toBe("siman:208 sk:7");
    expect(c!.rule).toBe("sk-siman-before");
    expect(loc(scan(['(עיין סימן תקסח במגן אברהם ס"ק י"א ועיין'])[0])).toBe("siman:568 sk:11");
  });
  it('a ס"ק after the part of the Shulchan Aruch just cited with its siman (קובץ פרשיות ומועדים, line 5027)', () => {
    const cs = scan(['דמבואר בשו"ע [עיין או"ח תמ"ב סעיף ז\' ומג"א ס"ק י\'] דלענין בל יראה']);
    expect(cs.map(books)).toEqual([["sa-oc"], ["ma"]]);
    expect(loc(cs[1])).toBe("siman:442 sk:10");
  });
  it('"סי\' תי"ו": 416 with 16 the plain way after hundreds (מקור מים חיים על בעל שם טוב, line 1626)', () => {
    const [c] = scan(['וע"ש גופא דעובדא היכי הוה. ועי\' מג"א סי\' תי"ו סק"ג שכז נהג']);
    expect(books(c)).toEqual(["ma"]);
    expect(loc(c)).toBe("siman:416 sk:3");
  });
});

describe("a chapter of the Yerushalmi or the Mishnah by its name (knowledge/chapter-names.json)", () => {
  it("the names are each book's own opening words", () => {
    expect(CHAPTER_OPENINGS["משנה ברכות"]?.[0]).toMatch(/^מאימתי/);
    expect(CHAPTER_OPENINGS["תלמוד ירושלמי סוכה"]?.[4]).toMatch(/^החליל/);
  });
  it('"בירושלמי דסוכה פ׳ החליל" (מטה דן, line 553), "בבבא קמא ירושלמי בפרק החובל" (מנורת המאור, line 1157)', () => {
    const [c] = scan(["וזה נמצא ברמז בירושלמי דסוכה פ׳ החליל ובמדרש איכה"]);
    expect(books(c)).toEqual(["y-suk"]);
    expect(loc(c)).toBe("perek:5");
    expect(c!.rule).toBe("chapter-name-other");
    expect(loc(scan(["וגרסי' בבבא קמא ירושלמי בפרק החובל, אע\"פ שהוא נותן"])[0])).toBe("perek:8");
  });
  it('with a halacha after it; and in a commentary on the Yerushalmi, its own tractate (פירוש שלמה סיריליו על תלמוד ירושלמי פאה, line 1187)', () => {
    expect(loc(scan(["ובירושלמי ברכות פרק אין עומדין הלכה א"])[0])).toBe("perek:5 halacha:1");
    const [c] = scan(["בזוכר את הקשין. בפ' גדיש מפ' למתני'"], "פירוש שלמה סיריליו על תלמוד ירושלמי פאה");
    expect(books(c)).toEqual(["y-peah"]);
    expect(loc(c)).toBe("perek:5");
  });
  it("not without the collection, not without the tractate, not a name that opens no chapter or two", () => {
    expect(scan(["ובירושלמי פרק אין עומדין"])).toHaveLength(0);
    expect(scan(["ובמשנה פרק זה"])).toHaveLength(0);
    expect(scan(["בירושלמי ברכות פרק כלשהו אחר"])).toHaveLength(0);
  });
});
