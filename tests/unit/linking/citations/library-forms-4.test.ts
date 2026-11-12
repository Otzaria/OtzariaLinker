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
    // a comparison in a bracket, with no ד"ה, does not move it
    expect(books(scan(['ובקדושין דף י"ו ע"ב (תוס\' שם) יעו"ש'])[0])).toEqual(["tos-kid"]);
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
  it('"פ"ב דברכות" with no word for the Gemara stays the Mishna\'s chapter', () => {
    const out = run('והכי מוכח פ"ב דברכות גבי הא');
    expect(out.map((s) => s.target.book.key)).toEqual(["m-ber"]);
  });
});
