import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import { toGematria } from "../../../../src/core/text/gematria";
import type { EngineBook } from "../../../../src/linking/automatic";
import { buildRefIndex, resolveAltDaf, runCitationsEngine, type DafStructure, type NamedUnitSource, type RefLine } from "../../../../src/linking/automatic/citations";

/*
 * The named-citation forms of the round of 16.11 (cite6; docs/AUTOMATION_ENGINE.md §6.3ו): citations whose book is
 * written, which LINKER links and the engine missed. The lines are the library's own (seforim.db; the book and the
 * line index in each test's name), cut to the sentence of the citation. Titles are the library's.
 */
const G = (n: number): string => toGematria(n).replace(/["'׳״]/g, "");
const ref = (key: string, title: string): BookRef => ({ key, title, origin: "sefaria" });

/** "<title>, <a>, <b>" for a = 1..levels1 and b = 1..levels2 (line 0 is the title) */
function twoLevels(title: string, a: number, b: number, from = 1): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  for (let i = from; i <= a; i++) for (let j = 1; j <= b; j++) out.push({ index: out.length, heRef: `${title}, ${G(i)}, ${G(j)}` });
  return out;
}
/** the line of "<a>, <b>" in twoLevels(…, b) */
const at = (a: number, b: number, per: number, from = 1) => 1 + (a - from) * per + (b - 1);

/** a Bavli-shaped book: per amud 2 lines, from daf ב */
function dafRefs(title: string, dapim: number, commentary = false): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  for (let d = 2; d <= dapim; d++) for (const side of [".", ":"]) for (let s = 1; s <= 2; s++) out.push({ index: out.length, heRef: commentary ? `${title}, ${G(d)}${side}, ${G(s)}, א` : `${title}, ${G(d)}${side}, ${G(s)}` });
  return out;
}
const amud = (daf: number, side: 1 | 2) => 1 + ((daf - 2) * 2 + (side - 1)) * 2;

const DEUT = ref("deut", "דברים");
const PROV = ref("prov", "משלי");
const EXOD = ref("exod", "שמות");
const TUR = ref("tur", "טור");
const BY = ref("by", "בית יוסף");
const LEVR = ref("levr", "ויקרא רבה");
const GENR = ref("genr", "בראשית רבה");
const SHIRR = ref("shirr", "שיר השירים רבה");
const YT = ref("yt", "ילקוט שמעוני על התורה");
const YN = ref("yn", 'ילקוט שמעוני על נ"ך');
const ISA = ref("isa", "ישעיהו");
const SHAB = ref("shab", "שבת");
const TOS_SHAB = ref("tos-shab", "תוספות על שבת");

/** the Tur: "טור, <part>, <siman>, <seif>" — two parts, 30 simanim of 12 seifim */
function turRefs(): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  for (const part of ["אורח חיים", "חושן משפט"]) for (let s = 1; s <= 30; s++) for (let f = 1; f <= 12; f++) out.push({ index: out.length, heRef: `טור, ${part}, ${G(s)}, ${G(f)}` });
  return out;
}
const turLine = (part: 0 | 1, siman: number, seif: number) => 1 + part * 360 + (siman - 1) * 12 + (seif - 1);
function byRefs(): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  for (const part of ["אורח חיים", "יורה דעה"]) for (let s = 1; s <= 30; s++) for (let f = 1; f <= 2; f++) out.push({ index: out.length, heRef: `בית יוסף, ${part}, ${G(s)}, ${G(f)}` });
  return out;
}

const REFS: Record<string, RefLine[]> = {
  deut: twoLevels("דברים", 5, 40),
  prov: twoLevels("משלי", 5, 20),
  exod: twoLevels("שמות", 20, 5),
  isa: twoLevels("ישעיהו", 5, 5),
  tur: turRefs(),
  by: byRefs(),
  levr: twoLevels("ויקרא רבה", 30, 3),
  genr: twoLevels("בראשית רבה", 48, 2),
  shirr: twoLevels("שיר השירים רבה", 8, 3),
  // the Yalkut's first level is its remez: on the Torah 1..48, on the Nach 1..40
  yt: twoLevels("ילקוט שמעוני על התורה", 48, 2),
  yn: twoLevels('ילקוט שמעוני על נ"ך', 40, 2),
  shab: dafRefs("שבת", 70),
  "tos-shab": dafRefs("תוספות על שבת", 70, true),
};
/** the Torah's parshiyot (from its alt_toc) and the Yalkut's own sections by parsha */
const UNITS: NamedUnitSource[] = [
  { book: EXOD, kind: "parsha", entries: [{ name: "שמות", line: 1 }, { name: "וארא", line: 30 }, { name: "משפטים", line: 60 }], lastLine: 100 },
  { book: YT, kind: "parsha", entries: [{ name: "שמות", line: 1 }, { name: "וארא", line: 21 }, { name: "משפטים", line: 41 }], lastLine: 96 },
];
const GEN = ref("gen", "בראשית");
const BOOKS = [GEN, DEUT, PROV, EXOD, TUR, BY, LEVR, GENR, SHIRR, YT, YN, ISA, SHAB, TOS_SHAB];
const source = (lines: string[], title = "חיבור כלשהו"): EngineBook => ({ book: { key: "src", title, origin: "otzaria" }, lines: lines.map((text, index) => ({ index, text, heading: null })) });
const run = (line: string, title?: string) =>
  runCitationsEngine(source([line], title), { catalog: BOOKS.map((b) => ({ book: b, aliases: b.key === "by" ? ['ב"י'] : [] })), units: UNITS, index: (b) => (REFS[b.key] ? buildRefIndex(b, REFS[b.key]!) : null) }).suggestions;
const rule = (s: { rules: readonly string[] }, r: string) => s.rules.includes(`citations.${r}`);

describe('"ד\'" and a numeral in a book of the Tanakh is chapter 4, not a daf', () => {
  it('"(דברים ד\' ל"ט)" (מגן אבות חלק א, line 61) and "(משלי ד\' י"ח)" (line 41)', () => {
    const [s] = run('וענין גילוי זה הוא כמ"ש (דברים ד\' ל"ט) שה\' הוא האלקים');
    expect(s!.target.book.key).toBe("deut");
    expect(s!.target.line).toBe(at(4, 39, 40));
    expect(rule(s!, "dalet-four")).toBe(true);
    expect(run('נוגה הולך ואור עד נכון היום (משלי ד\' י"ח) ושם')[0]!.target.line).toBe(at(4, 18, 20));
  });
  it('not with an amud after it ("ד\' ע"ב" is a daf), and not "דף" written out', () => {
    expect(run('כמו שכתוב בדברים ד\' ע"ב ושם')).toHaveLength(0);
    expect(run('כמו שכתוב בדברים דף ל"ט ושם')).toHaveLength(0);
  });
});

describe("the Tur's seif, and a part of the Shulchan Aruch with a bare siman", () => {
  it('"בטור חו"מ סימן רס"ב ס"ט" — here siman 26 seif 9 (הלכה למשה, line 1347): the Tur\'s second level', () => {
    const [s] = run('אגב יוקרייהו מידע ידיעי וכ"כ בטור חו"מ סימן כ"ו ס"ט ושם');
    expect(s!.target.book.key).toBe("tur");
    expect(s!.target.line).toBe(turLine(1, 26, 9));
    expect(rule(s!, "tur-seif")).toBe(true);
    expect(run('וכ"כ בטור חו"מ סי\' כ"א סעיף י"א ושם')[0]!.target.line).toBe(turLine(1, 21, 11));
  });
  it('"טור או"ח כה, בשם" and "בית יוסף או"ח כז לדעת" (מיקרופדיה תלמודית): one bare number after the part is its siman', () => {
    const [t] = run("ונמצא (תוספות שם; טור או\"ח כז, בשם הירושלמי)");
    expect(t!.target.book.key).toBe("tur");
    expect(t!.target.line).toBe(turLine(0, 27, 1));
    expect(rule(t!, "part-siman")).toBe(true);
    const [b] = run('ואין בו ששים (מאירי שם; בית יוסף או"ח כז לדעת הרמב"ם)');
    expect(b!.target.book.key).toBe("by");
  });
  it('not a number that is also a word ("באו"ח לא נזכר"), and "ב"י ליו"ד סי\' כ"ו" takes the part with a ל (הלכה למשה, line 281)', () => {
    expect(run('והטור באו"ח לא נזכר זה')).toHaveLength(0);
    const [s] = run('וכ"כ ב"י ליו"ד סי\' כ"ו ושם');
    expect(s?.target.book.key).toBe("by");
  });
});

describe("a parasha of a Midrash Rabbah", () => {
  it('"(שיר השירים רבה פרשה א\')" (מחשבות חרוץ, line 38): "פרשה" before the number', () => {
    const [s] = run('ועד"ש (שיר השירים רבה פרשה ב\') ושם');
    expect(s!.target.book.key).toBe("shirr");
    expect(s!.target.line).toBe(at(2, 1, 3));
    expect(rule(s!, "rabbah-parsha")).toBe(true);
  });
  it('"(ויק"ר רפכ"ב)" and "(ב"ר ספמ"ז)" (מגן אבות חלק א): the start / end of a parasha, not 302 or a chapter beyond 30', () => {
    expect(run('כמארז"ל (ויק"ר רפכ"ב) ושם')[0]!.target.line).toBe(at(22, 1, 3));
    expect(run('כמארז"ל (ב"ר ספמ"ז) ושם')[0]!.target.book.key).toBe("genr");
    expect(run('כמארז"ל (ב"ר ספמ"ז) ושם')[0]!.target.line).toBe(at(47, 1, 2));
  });
  it('"בויקרא רבה סוף פ"ד" (הלכה למשה) and "במד"ר בראשית רפ"ה" (מגן אבות חלק א)', () => {
    expect(run('והוא שאמרו בויקרא רבה סוף פ"ד ושם')[0]!.target.line).toBe(at(4, 1, 3));
    const [s] = run('וארז"ל במד"ר בראשית רפ"ה ושם');
    expect(s!.target.book.key).toBe("genr");
    expect(s!.target.line).toBe(at(5, 1, 2));
  });
});

describe("the Yalkut Shimoni by parasha or book, and its remez", () => {
  it('"בילקוט (יתרו רמז רפ"ו)" — here "(משפטים רמז מ"ב)" (מגן אבות חלק א, line 325): the remez in the Yalkut on the Torah', () => {
    const [s] = run('איתא בילקוט (משפטים רמז מ"ב) ושם');
    expect(s!.target.book.key).toBe("yt");
    expect(s!.target.line).toBe(at(42, 1, 2));
    expect(s!.confidence).toBe("certain");
    expect(rule(s!, "yalkut-remez")).toBe(true);
  });
  it('"בילקוט בישעי\' (רמז ל"ג)" (מגן אבות חלק א, line 367) and "בילקוט (תלים תרי"ג)": the Yalkut on the Nach', () => {
    const [s] = run('והנה בילקוט בישעי\' (רמז ל"ג) ושם');
    expect(s!.target.book.key).toBe("yn");
    expect(s!.target.line).toBe(at(33, 1, 2));
  });
  it('"בילקוט פרשת משפטים" (הלכה למשה, line 496): the parasha\'s section of the Yalkut — the whole unit, "possible"', () => {
    const [s] = run("ושוב מצאתי הגירסא הזאת בילקוט פרשת משפטים ושם");
    expect(s!.target.book.key).toBe("yt");
    expect(s!.target.line).toBe(41);
    expect(s!.confidence).toBe("possible");
  });
  it('a numeral alone after the book is its chapter, not a remez ("בילקוט (תהלים מ"ג)", משלי יעקב, line 794 — found by the hand check of HELDOUT4)', () => {
    expect(run('כמ"ש בילקוט (ישעיה ל"ג) על מאמר').filter((s) => s.target.book.key === "yn")).toHaveLength(0);
  });
  it('"ילקוט" with no parasha or book after it is no citation; a book of the Nach with no remez is not linked', () => {
    expect(run("כמ\"ש בילקוט הנ\"ל ושם")).toHaveLength(0);
    expect(run("ויעקב (ילקוט ישעיה) ושם").filter((s) => s.target.book.key === "yn")).toHaveLength(0);
  });
});

describe("a place, and the commentator's words on it after a comma and ו", () => {
  it('"(שבת סח א, ותוס\' ד"ה דאית)" (מיקרופדיה תלמודית, line 220): the Gemara and Tosafot, each its own suggestion', () => {
    const out = run('מדרבנן יש תולדות לשביעית (שבת סח א, ותוס\' ד"ה דאית). ושם');
    expect(out.map((s) => s.target.book.key).sort()).toEqual(["shab", "tos-shab"]);
    const base = out.find((s) => s.target.book.key === "shab")!;
    expect(base.target.line).toBe(amud(68, 1));
    expect(rule(base, "commentator-after-base")).toBe(true);
  });
  it('without the ו, or with the commentator before the place, only the commentary', () => {
    expect(run('ועיין (שבת סח א) תוס\' ד"ה דאית ושם').map((s) => s.target.book.key)).toEqual(["tos-shab"]);
    expect(run('ועיין תוס\' שבת סח א ד"ה דאית ושם').map((s) => s.target.book.key)).toEqual(["tos-shab"]);
  });
});

describe("a page of the Zohar with the amud as a lone letter", () => {
  const ZOHAR = ref("zohar", "ספר הזהר");
  const ds: DafStructure = {
    book: ZOHAR,
    entries: [
      { volume: 2, n: 48, amud: 1, line: 100, end: 110 },
      { volume: 2, n: 48, amud: 2, line: 111, end: 120 },
      { volume: 3, n: 48, amud: 1, line: 500, end: 510 },
    ],
    sections: [],
  };
  const num = (n: number, form: "gershayim" | "geresh") => ({ n, form, common: false }) as const;
  it('"בזוהר (ח"ב מ"ח א\')" (מגן אבות חלק א, line 231): volume 2, page 48 side a', () => {
    const r = resolveAltDaf(ds, [{ kind: "chelek", n: 2, explicit: true, numeral: num(2, "gershayim") }, { kind: "?", n: 48, explicit: false, numeral: num(48, "gershayim") }, { kind: "?", n: 1, explicit: false, numeral: num(1, "geresh") }], null);
    expect(r?.line).toBe(100);
    expect(r?.end).toBe(110);
  });
  it("a second number that is not a lone letter is no amud", () => {
    expect(resolveAltDaf(ds, [{ kind: "chelek", n: 2, explicit: true, numeral: num(2, "gershayim") }, { kind: "?", n: 48, explicit: false, numeral: num(48, "gershayim") }, { kind: "?", n: 1, explicit: false, numeral: num(1, "gershayim") }], null)).toBeNull();
  });
});

describe("book names as books write them (knowledge/book-names.json)", () => {
  const CH = ref("chas", "ספר חסידים");
  const chRefs: RefLine[] = [{ index: 0, heRef: null }, ...Array.from({ length: 30 }, (_, i) => ({ index: i + 1, heRef: `ספר חסידים, ${G(i + 1)}, א` }))];
  const runCh = (line: string) => runCitationsEngine(source([line]), { catalog: [{ book: CH }], index: (b) => buildRefIndex(b, chRefs) }).suggestions;
  it('"בספר החסידים סי\' י"ח" (חמדת ימים ב) and "ס\' החסידים (סי\' כ"ט)": ספר חסידים', () => {
    expect(runCh('כמ"ש בספר החסידים סי\' י"ח ושם')[0]?.target.line).toBe(18);
    expect(runCh('וכמ"ש ס\' החסידים (סי\' כ"ט) ושם')[0]?.target.line).toBe(29);
  });
});
