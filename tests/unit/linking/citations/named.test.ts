import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../../src/core/links/model";
import type { EngineBook } from "../../../../src/linking/automatic";
import { buildRefIndex, runCitationsEngine, unitsFromAltToc, type CitationLibrary, type NamedUnitSource, type RefLine } from "../../../../src/linking/automatic/citations";
import { looseWord, NamedUnitIndex } from "../../../../src/linking/automatic/citations/named";
import { citationTokens } from "../../../../src/linking/automatic/citations/text";

/*
 * Units cited by NAME (named.ts, detect.ts `named`, engine.ts `resolveUnit`): the Bavli's chapters and
 * the Torah's parshiyot as the library's alt_toc names them, a book's own alt_toc units, and a named
 * level of a book's references (the Zohar's parshiyot).
 */

/*
 * Otzaria books by default: these tests are about resolving names to ranges. A Sefaria book never gets a
 * range on its side (the weekly sync moves only the start line — security review B1); the last test
 * below checks that rule with named units too.
 */
const ref = (key: string, title: string, origin: BookRef["origin"] = "otzaria"): BookRef => ({ key, title, origin });
const G = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];

/** a Bavli-shaped book: line 0 the title, then per amud a heading and 3 lines (daf ב. starts at line 1) */
function bavliRefs(title: string, dapim: number): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  for (let d = 2; d <= dapim; d++)
    for (const side of [".", ":"]) {
      out.push({ index: out.length, heRef: null });
      for (let s = 1; s <= 3; s++) out.push({ index: out.length, heRef: `${title}, ${G[d]}${side}, ${G[s]}` });
    }
  return out;
}
/** the first line (the heading) of an amud in bavliRefs: daf 2 side a = 1 */
const amud = (daf: number, side: 1 | 2) => 1 + ((daf - 2) * 2 + (side - 1)) * 4;

function tanakhRefs(title: string, chapters: number[]): RefLine[] {
  const out: RefLine[] = [{ index: 0, heRef: null }];
  chapters.forEach((verses, c) => {
    out.push({ index: out.length, heRef: null });
    for (let v = 1; v <= verses; v++) out.push({ index: out.length, heRef: `${title}, ${G[c + 1]}, ${G[v]}` });
  });
  return out;
}

const BER = ref("ber", "ברכות");
const SHAB = ref("shab", "שבת");
const KID = ref("kid", "קידושין");
const GEN = ref("gen", "בראשית");
const TOS = ref("tos", "תוספות על ברכות");
const ZOHAR = ref("zohar", "ספר הזהר");
const SHEILTOT = ref("sheil", "שאילתות דרב אחאי גאון");
const SRC = ref("src", "חיבור כלשהו", "otzaria");

const berRefs = bavliRefs("ברכות", 6); // lines 0..40
const shabRefs = bavliRefs("שבת", 4); // lines 0..24
const kidRefs = bavliRefs("קידושין", 3);
const tosRefs = bavliRefs("תוספות על ברכות", 6);
const genRefs = tanakhRefs("בראשית", [4, 4, 4]); // ch1 verses at 2-5, ch2 at 7-10, ch3 at 12-15
const zoharRefs: RefLine[] = [
  { index: 0, heRef: null },
  ...[1, 2, 3].map((i) => ({ index: i, heRef: `ספר הזהר, בראשית, א, ${G[i]}` })),
  ...[4, 5, 6].map((i) => ({ index: i, heRef: `ספר הזהר, נח, א, ${G[i - 3]}` })),
  ...[7, 8].map((i) => ({ index: i, heRef: `ספר הזהר, שלח לך, א, ${G[i - 6]}` })),
];
const sheiltotRefs: RefLine[] = Array.from({ length: 10 }, (_, i) => ({ index: i, heRef: i ? `שאילתות דרב אחאי גאון, ${G[i]}` : null }));

const alt = (book: BookRef, kind: "chapter" | "parsha", entries: [string, number][], lastLine: number): NamedUnitSource =>
  unitsFromAltToc(book, kind, [{ key: kind === "chapter" ? "Chapters" : "Parasha", heTitle: kind === "chapter" ? "פרקים" : "פרשות", entries: entries.map(([heTitle, line]) => ({ heTitle, line: line + 1, level: 0 })) }], lastLine)!;

const UNITS: NamedUnitSource[] = [
  // ברכות: מאימתי from daf ב., היה קורא from daf ד. (line 25)
  alt(BER, "chapter", [["מאימתי", 1], ["היה קורא", amud(4, 1)], ["האשה שהיא עושה", amud(5, 1)]], berRefs.length - 1),
  // שבת shares a name with ברכות ("היה קורא"), and has "האשה" and two names that start with common words
  alt(SHAB, "chapter", [["היה קורא", 1], ["האשה", amud(3, 1)], ["זה בורר", amud(4, 1)], ["אלו הן הנחנקין", amud(4, 2)]], shabRefs.length - 1),
  // a commentary's own chapters (not an indexed book: used only when a citation moves to it)
  alt(TOS, "chapter", [["מאימתי", 1], ["היה קורא", amud(4, 1)], ["האשה שהיא עושה", amud(5, 1)]], tosRefs.length - 1),
  // בראשית: פרשת בראשית from 1:1, נח from 2:1 (line 6)
  alt(GEN, "parsha", [["בראשית", 1], ["נח", 6], ["לך לך", 11]], genRefs.length - 1),
  // a book arranged by parshiyot (its own Parasha structure)
  alt(SHEILTOT, "parsha", [["בראשית", 1], ["נח", 4]], sheiltotRefs.length - 1),
];

function library(extra: NamedUnitSource[] = []): CitationLibrary {
  const books: [BookRef, RefLine[], string[]?][] = [
    [BER, berRefs],
    [SHAB, shabRefs],
    [KID, kidRefs],
    [GEN, genRefs],
    [TOS, tosRefs],
    [ZOHAR, zoharRefs],
    [SHEILTOT, sheiltotRefs, ["שאילתות"]],
  ];
  return {
    catalog: books.map(([book, , aliases]) => ({ book, ...(aliases && { aliases }) })),
    units: [...UNITS, ...extra],
    index: (b) => buildRefIndex(b, books.find(([x]) => x.key === b.key)![1]),
  };
}

const source = (lines: string[], book = SRC): EngineBook => ({ book, lines: lines.map((text, index) => ({ index, text, heading: null })) });
const run = (lines: string[], book = SRC, lib = library()) => runCitationsEngine(source(lines, book), lib);

describe("named units: data", () => {
  it("unitsFromAltToc: top-level entries, each to the line before the next; out of order → none", () => {
    const units = NamedUnitIndex.build([UNITS[0]!]).byBook.get("ber")!;
    expect(units.map((u) => [u.name, u.line, u.end, u.ordinal])).toEqual([
      ["מאימתי", 1, amud(4, 1) - 1, 1],
      ["היה קורא", amud(4, 1), amud(5, 1) - 1, 2],
      ["האשה שהיא עושה", amud(5, 1), berRefs.length - 1, 3],
    ]);
    expect(unitsFromAltToc(BER, "chapter", [{ key: "Chapters", entries: [{ heTitle: "ב", line: 9, level: 0 }, { heTitle: "א", line: 3, level: 0 }] }], 40)).toBeNull();
    // the Torah's structure is "Parasha", not "Chapters"
    expect(unitsFromAltToc(GEN, "parsha", [{ key: "Chapters", entries: [{ heTitle: "א", line: 1, level: 0 }] }], 40)).toBeNull();
  });

  it("names compare loosely (ו/י inside a word), but the last letter stays", () => {
    expect(looseWord("האישה")).toBe(looseWord("האשה"));
    expect(looseWord("בחוקתי")).toBe(looseWord("בחקתי"));
    expect(looseWord("פינחס")).toBe(looseWord("פנחס"));
    expect(looseWord("ממנו")).not.toBe(looseWord("מומין"));
    expect(looseWord("תצא")).not.toBe(looseWord("תצוה"));
    const ix = NamedUnitIndex.build(UNITS);
    // the most words win: "האשה שהיא" is ברכות' chapter only, not שבת's "האשה"
    const m = ix.matchAt(citationTokens("האשה שהיא עושה"), 0, ["chapter"])!;
    expect(m.matches.map((x) => [x.unit.book.key, x.full])).toEqual([["ber", true], ["tos", true]]);
    const one = ix.matchAt(citationTokens("האשה ופ"), 0, ["chapter"])!;
    expect(one.matches.map((x) => [x.unit.book.key, x.full]).sort()).toEqual([["ber", false], ["shab", true], ["tos", false]]);
  });
});

describe("named units: chapters", () => {
  it("a chapter name alone links to the whole chapter, at most 'possible' (a coarse target)", () => {
    const [named] = run(["כדאמרינן בברכות פרק מאימתי ע״ש"]).suggestions;
    expect(named!.target).toEqual({ book: BER, line: 1, end: amud(4, 1) - 1 });
    expect(named!.confidence).toBe("possible");
    expect(named!.rules).toEqual(expect.arrayContaining(["citations.named", "citations.unit-chapter", "citations.unit-context-named"]));
    const [alone] = run(["כדאיתא בפ' מאימתי ע״ש"]).suggestions;
    expect(alone!.target).toEqual(named!.target);
    expect(alone!.score).toBeLessThan(named!.score);
  });

  it("a name shared by two tractates is not guessed; a tractate next to it, or the commentary's base, picks one", () => {
    expect(run(["כדאיתא בפרק היה קורא ע״ש"]).suggestions).toHaveLength(0);
    expect(run(["כדאיתא בפרק היה קורא דשבת ע״ש"]).suggestions[0]!.target.book).toEqual(SHAB);
    expect(run(["כדאיתא בשבת פרק היה קורא"]).suggestions[0]!.target.book).toEqual(SHAB);
    const base = run(["כדאיתא בפרק היה קורא"], ref("c", "חידושים על ברכות", "otzaria")).suggestions[0]!;
    expect(base.target).toEqual({ book: BER, line: amud(4, 1), end: amud(5, 1) - 1 });
    expect(base.rules).toContain("citations.unit-context-base");
  });

  it("partial names: the full name wins over one partial; two or more partials, a short word or a contradicting word — no guess", () => {
    // "האשה" alone: שבת's full name; ברכות' "האשה שהיא עושה" only starts with it
    expect(run(["כמבואר בפרק האשה ושם"]).suggestions[0]!.target.book).toEqual(SHAB);
    // …but with קידושין's "האשה נקנית" too, the words start two other names
    expect(run(["כמבואר בפרק האשה ושם"], SRC, library([alt(KID, "chapter", [["האשה נקנית", 1]], kidRefs.length - 1)])).suggestions).toHaveLength(0);
    // with ברכות named, its "האשה שהיא עושה" is meant
    const p = run(["כמבואר בברכות פרק האשה ושם"]).suggestions[0]!;
    expect(p.target).toEqual({ book: BER, line: amud(5, 1), end: berRefs.length - 1 });
    expect(p.rules).toContain("citations.unit-partial");
    // "בפרק זה" is "in this chapter", not "זה בורר"
    expect(run(["כמו שכתבתי בפרק זה ושם"]).suggestions).toHaveLength(0);
    // "אלו הן הנשרפין" is not "אלו הן הנחנקין"
    expect(run(["כדאיתא בשבת פרק אלו הן הנשרפין"]).suggestions).toHaveLength(0);
    expect(run(["כדאיתא בשבת פרק אלו הן (דף ד:)"]).suggestions).toHaveLength(1);
  });

  it("a daf after the name is resolved in the tractate, only inside the chapter, and is as sure as the location", () => {
    const [d] = run(["ועיין בפ' מאימתי (דף ג:) ושם"]).suggestions;
    expect(d!.target).toEqual({ book: BER, line: amud(3, 2) + 1, end: amud(3, 2) + 3 });
    expect(d!.confidence).toBe("high");
    expect(run(["ועיין בפ' מאימתי (דף ה.) ושם"]).suggestions).toHaveLength(0);
    // "[ברכות ג:]" in brackets after the name: the tractate is named — as sure as "ברכות ג:"
    const [n] = run(["ועיין פרק מאימתי [ברכות ג:] ושם"]).suggestions;
    expect(n!.target.line).toBe(amud(3, 2) + 1);
    expect(n!.confidence).toBe("certain");
  });

  it("another collection's word before it (ירושלמי, משנה) — not the Bavli's chapter, no link", () => {
    expect(run(["ועיין בירושלמי פרק מאימתי"]).suggestions).toHaveLength(0);
    expect(run(["ועיין במשנה בפרק מאימתי"]).suggestions).toHaveLength(0);
    expect(run(["ועיין בגמ' פרק מאימתי"]).suggestions).toHaveLength(1);
  });

  it("a commentator before it moves it to the commentary, located by the commentary's own chapters", () => {
    const [s] = run(['וכמ"ש תוס\' ריש פרק היה קורא דברכות']).suggestions;
    expect(s!.target).toEqual({ book: TOS, line: amud(4, 1), end: amud(5, 1) - 1 });
    expect(s!.rules).toContain("citations.commentator");
  });

  it("a name with no chapter word, or after מפ' (\"מפרש\"), is not a citation", () => {
    expect(run(["מאימתי קורין את שמע"]).suggestions).toHaveLength(0);
    expect(run(["ועיין מפ' מאימתי"]).suggestions).toHaveLength(0);
  });
});

describe("named units: a shared name told apart by its daf, initials, the Aramaic plural", () => {
  it("a name two tractates share: the one whose chapter holds the daf; neither — no link", () => {
    // ברכות' "היה קורא" runs from daf ד., שבת's from daf ב.
    const [b] = run(["כדאיתא בפרק היה קורא (דף ד:) ע״ש"]).suggestions;
    expect(b!.target.book).toEqual(BER);
    expect(b!.confidence).toBe("high");
    expect(b!.rules).toContain("citations.unit-context-unique");
    expect(run(["כדאיתא בפרק היה קורא (דף ב.) ע״ש"]).suggestions.map((s) => s.target.book.key)).toEqual(["shab"]);
    expect(run(["כדאיתא בפרק היה קורא (דף ו.) ע״ש"]).suggestions).toHaveLength(0);
    // without a daf it is still not guessed
    expect(run(["כדאיתא בפרק היה קורא ע״ש"]).suggestions).toHaveLength(0);
  });

  it("a name written as its initials (\"פ' אע\"פ\"), never a numeral", () => {
    const lib = library([alt(KID, "chapter", [["אף על פי", 1]], kidRefs.length - 1)]);
    const [k] = run(["כדאיתא בפ' אע\"פ (דף ב:) ע״ש"], SRC, lib).suggestions;
    expect(k!.target.book).toEqual(KID);
    expect(run(["כדאיתא בפ' י\"ב (דף ב:) ע״ש"], SRC, lib).suggestions.every((s) => s.target.book.key !== "kid" || !s.rules.includes("citations.named"))).toBe(true);
  });

  it("the Aramaic plural ending compares as the Hebrew one", () => {
    expect(looseWord("אחין")).toBe(looseWord("אחים"));
    expect(looseWord("ממנו")).not.toBe(looseWord("מומין"));
  });
});

describe("named units: parshiyot", () => {
  it("בפרשת נח → the parsha's range in the Torah book (possible); 'פ' נח' and 'הפרשת' are not parsha citations", () => {
    const [s] = run(["כמו שכתבנו בפרשת נח ע״ש"]).suggestions;
    expect(s!.target).toEqual({ book: GEN, line: 6, end: 10 });
    expect(s!.confidence).toBe("possible");
    expect(run(["כמו שכתבנו בפ' נח"]).suggestions).toHaveLength(0);
    expect(run(["בענין הפרשת נח"]).suggestions).toHaveLength(0);
    // "פרשת בראשית" is the parsha, not the book
    expect(run(["כמו שכתבנו בפרשת בראשית"]).suggestions[0]!.target).toEqual({ book: GEN, line: 1, end: 5 });
  });

  it("a verse after the parsha must be inside it; then it is as sure as the verse", () => {
    const [v] = run(["כמ\"ש בפרשת נח (ב, ג) ע״ש"]).suggestions;
    expect(v!.target).toEqual({ book: GEN, line: 9 });
    expect(["certain", "high"]).toContain(v!.confidence);
    expect(run(["כמ\"ש בפרשת נח (ג, ב) ע״ש"]).suggestions).toHaveLength(0);
  });

  it("a book named before the parsha: its own parsha structure, or a level of its references (the Zohar) — never the Torah", () => {
    // "נח" in the Zohar's references reads as the number 58: still found among the named levels
    const [z] = run(["כדאיתא בזוהר פרשת נח ע״ש"]).suggestions;
    expect(z!.target).toEqual({ book: ZOHAR, line: 4, end: 6 });
    // the Zohar writes "שלח לך" where the Torah's structure has "שלח"
    const withShelach: CitationLibrary = { ...library(), units: [...UNITS.slice(0, 3), alt(GEN, "parsha", [["בראשית", 1], ["נח", 6], ["שלח", 11]], genRefs.length - 1)] };
    expect(runCitationsEngine(source(["כדאיתא בזוהר פרשת שלח ע״ש"]), withShelach).suggestions[0]!.target).toEqual({ book: ZOHAR, line: 7, end: 8 });
    // a book arranged by parshiyot: its own alt_toc
    expect(run(["כדאיתא בשאילתות פרשת נח"]).suggestions[0]!.target).toEqual({ book: SHEILTOT, line: 4, end: 9 });
    // a book with neither: dropped, not sent to the Torah
    expect(run(["כדאיתא בתוספות על ברכות פרשת נח"]).suggestions).toHaveLength(0);
    // a tractate before it is not the parsha's book ("בשבת פרשת נח" — on the Sabbath of parshat Noach)
    expect(run(["בשבת פרשת נח"]).suggestions.map((s) => s.target.book.key)).toEqual(["gen"]);
  });
});

describe("named units in a Sefaria book", () => {
  it("never a range on the Sefaria side (the weekly sync moves only the start — B1): the unit's first line", () => {
    const BER_S: BookRef = { ...BER, origin: "sefaria" };
    const lib: CitationLibrary = {
      catalog: [{ book: BER_S }],
      units: [alt(BER_S, "chapter", [["מאימתי", 1], ["היה קורא", amud(4, 1)]], berRefs.length - 1)],
      index: () => buildRefIndex(BER_S, berRefs),
    };
    const [s] = run(["כדאמרינן בברכות פרק מאימתי ע״ש"], SRC, lib).suggestions;
    expect(s!.target).toEqual({ book: BER_S, line: 1 });
    expect(s!.citedSpan).toEqual({ line: 1, end: amud(4, 1) - 1 });
    expect(s!.warnings.map((w) => w.code)).toContain("citations/range-first-line");
  });
});
