import { describe, expect, it } from "vitest";
import type { Link } from "../../../../src/core/links/model";
import { validateLink, type ValidationContext } from "../../../../src/core/links/validate";
import { AliasIndex, buildHeadingsIndex, citationGate, citationHintStrength, type CitationLibrary } from "../../../../src/linking/automatic/citations";
import { B, BOOKS, dapim, heRefOf, LIB, libraryOf, ref, run } from "./v7-fixture";

/*
 * The V7 round of the citations engine (spec §2.9, §2.10; issue #23; review findings #41 B6–B9, #42 C17–C21). Each block
 * reproduces one finding on skeleton books with the database's heRef shapes (v7-fixture.ts); no book text.
 */

const names = AliasIndex.build(LIB.catalog);
const knows = (k: string) => names.hasFirstWord(k);

describe("B6 — a book that cites only as 'ברכות יג:' opens the gate", () => {
  // the open book's name and a daf in letters with its amud mark glued on: an address with no place word (issue #23's first form)
  it.each(["ברכות יג:", "ברכות יג.", "(ברכות יג:)", "ועיין בברכות יג. ושם", "וכן וברכות כ\"ג: ועוד", "ברכות יג׃ ועוד"])("%s: strong", (t) => {
    expect(citationHintStrength(t, knows)).toBe("strong");
  });

  it.each(["ברכות יג ועוד", "הלך לברכות. ושם", "אמר ברכות רבות.", "ברכות יג:"])("%s: not strong (no amud mark, no numeral, or no open book)", (t) => {
    // the last one without the names of the open books: nothing says "ברכות" is a book
    expect(citationHintStrength(t, t === "ברכות יג:" ? undefined : knows)).not.toBe("strong");
  });

  it("a four-line book of such citations opens the book-level gate", () => {
    const g = citationGate(knows);
    const open = ["פתיחה לספר", "כמו שאמרו ברכות יג: ושם", "ועיין שבת לא. ושם", "ועוד בביצה יב: ושם"].map((l) => g.add(l));
    expect(open).toEqual([false, true, true, true]);
  });
});

describe("B7 — a ד\"ה with no commentator's name still links the daf", () => {
  // the words of a ד"ה are some commentary's on that daf, which one is not written: the daf itself is the nearest sure place,
  // and a coarse one — "possible" (before: dropped as dibur-without-commentator, nothing linked and nothing listed)
  it.each(['ועיין ברכות יג: ד"ה והא ושם', 'ועיין (ברכות יג: ד"ה והא) ושם'])("%s", (text) => {
    const r = run(text);
    expect(r.suggestions).toHaveLength(1);
    const s = r.suggestions[0]!;
    expect(s.target.book.key).toBe(B.ber.key);
    expect(heRefOf(B.ber, s.target.line)).toBe("ברכות, יג:, א");
    expect(s.confidence).toBe("possible");
    expect(s.rules).toContain("citations.dibur-no-commentator");
    expect(s.reasons.map((x) => x.text).join(" ")).toContain('ד"ה');
  });

  it("with the commentator's name it is still his words (control)", () => {
    const s = run('ועיין תוס\' ברכות יג: ד"ה והא ושם').suggestions[0]!;
    expect(s.target.book.key).toBe(B.tosBer.key);
  });
});

describe("B8 — a bare Arabic number between a book's name and a Hebrew noun is a quantity, not an address", () => {
  it.each([
    ["הוריות 10 סעיפים", B.hor],
    ["יהושע 9 דברים", B.josh],
    ["נדרים 50 אחוז", B.ned],
    ["ביצה 12 גרם", B.bei],
    ["מגילה 25 מילים", B.meg],
  ] as const)("%s: at most possible", (text, book) => {
    const r = run(`כתוב ${text} ועוד`);
    const to = r.suggestions.filter((x) => x.target.book.key === book.key);
    for (const s of to) expect(s.confidence).toBe("possible");
  });

  it("the same number with a place word, in brackets or with a second number keeps its confidence (control)", () => {
    expect(run("ועיין יהושע פרק 9 ושם").suggestions[0]!.confidence).toBe("certain");
    expect(run("ועיין (יהושע 9) ושם").suggestions[0]!.confidence).not.toBe("possible");
    expect(run("כמו שנאמר יהושע 9, 2 ועוד").suggestions[0]!.confidence).not.toBe("possible");
  });
});

describe("B9 — a book of a personal database gets the 'ציטוט בטקסט' anchor for private use", () => {
  const text = "כמו שאמרו (ברכות יג:) ושם";
  it("citationType inline-linker: INLINE_LINKER with an anchor on the citation words, from a personal book too", () => {
    const r = run(text, { citationType: "inline-linker" }, LIB, "personal");
    const s = r.suggestions[0]!;
    expect(s.declaredType).toBe("INLINE_LINKER");
    expect(text.slice(s.anchor!.rawStart, s.anchor!.rawEnd!)).toBe("ברכות יג:");
    expect(r.notes.map((n) => n.code)).toContain("citations/inline-linker");
    expect(r.notes.map((n) => n.code)).not.toContain("citations/anchors-source");
  });

  it("the default (reference, which a library export accepts) stays without an anchor, and the note says how to get one for private use", () => {
    const r = run(text, {}, LIB, "personal");
    expect(r.suggestions[0]!.anchor).toBeUndefined();
    expect(r.suggestions[0]!.declaredType).toBe("reference");
    const note = r.notes.find((n) => n.code === "citations/anchors-source")!;
    expect(note.text).toContain("ציטוט בטקסט");
    expect(note.text).toContain("לשימוש פרטי");
  });

  it("the export accepts that link for private use and holds it back from the library (validateLink, LINK_FORMATS §1.12)", () => {
    const s = run(text, { citationType: "inline-linker" }, LIB, "personal").suggestions[0]!;
    const link: Link = { id: s.id, status: "new", provenance: "auto", source: s.source, target: s.target, declaredType: s.declaredType, heRef2: s.heRef2, anchor: s.anchor! };
    const ctx: ValidationContext = { line: () => ({ exists: true, heading: null, anchorLength: 40 }), lineCount: () => 1000 };
    const errors = (purpose?: "private") => validateLink(link, { ...ctx, ...(purpose && { purpose }) }).filter((p) => p.severity === "error").map((p) => p.code);
    expect(errors("private")).toEqual([]);
    expect(errors()).toContain("export/inline-linker-private-only");
  });

  it("a Sefaria source still gets none, whatever the type (control)", () => {
    expect(run(text, { citationType: "inline-linker" }, LIB, "sefaria").suggestions[0]!.anchor).toBeUndefined();
  });
});

describe("C17 — a range of verses is a target range where the record may carry one", () => {
  const text = "כמו שנאמר (בראשית א, א-ג) ועוד";
  const verse = (n: number) => BOOKS.find((b) => b.book.key === B.gen.key)!.refs.findIndex((r) => r.heRef === `בראשית, א, ${["", "א", "ב", "ג"][n]}`);

  it("'ציטוט בטקסט' (private use: LINK_FORMATS §1.12 allows line_index_2_end): verses א–ג, also in a Sefaria book", () => {
    const s = run(text, { citationType: "inline-linker" }).suggestions[0]!;
    expect(s.declaredType).toBe("INLINE_LINKER");
    expect(s.target).toEqual({ book: B.gen, line: verse(1), end: verse(3) });
    expect(s.heRef2).toBe("בראשית א, א-ג");
    // for private use the export writes it (the range on the Sefaria side is a warning there: it holds until Sefaria changes)
    const link: Link = { id: s.id, status: "new", provenance: "auto", source: s.source, target: s.target, declaredType: s.declaredType, heRef2: s.heRef2, anchor: s.anchor! };
    const ctx: ValidationContext = { line: () => ({ exists: true, heading: null, anchorLength: 40 }), lineCount: () => 1000, purpose: "private" };
    expect(validateLink(link, ctx).filter((p) => p.severity === "error")).toEqual([]);
  });

  it("a book that is not Sefaria's: the range, in the default type too", () => {
    const own = ref("own", "בראשית", "otzaria");
    const lib = libraryOf([{ book: own, refs: BOOKS[0]!.refs }]);
    const s = run(text, {}, lib).suggestions[0]!;
    expect(s.target).toEqual({ book: own, line: verse(1), end: verse(3) });
  });

  it("a 'reference' into a Sefaria book: the first verse, and the span is kept (citedSpan) — the weekly sync remaps only the start (§1.8)", () => {
    const s = run(text).suggestions[0]!;
    expect(s.target).toEqual({ book: B.gen, line: verse(1) });
    expect(s.citedSpan).toEqual({ line: verse(1), end: verse(3) });
    expect(s.warnings.map((w) => w.code)).toContain("citations/range-first-line");
  });
});

describe("C18 — a link to a unit starts at its first line of content, not at its heading (export/heading-line)", () => {
  it("a chapter cited by name (alt_toc), whose entry is the chapter's heading line: the first line under it", () => {
    const ket = ref("ket", "כתובות", "otzaria");
    const refs = dapim("כתובות", 12);
    const lib: CitationLibrary = { ...libraryOf([{ book: ket, refs }]), units: [{ book: ket, kind: "chapter", entries: [{ name: "המדיר", line: 1 }, { name: "אף על פי", line: 25 }], lastLine: refs.length - 1 }] };
    expect(refs[1]!.heRef).toBeNull(); // the alt_toc entry: the heading of daf ב.
    const s = run("ועיין בפרק המדיר דכתובות ושם", {}, lib).suggestions[0]!;
    expect(s.target.book.key).toBe("ket");
    expect(s.target.line).toBe(2);
    expect(refs[2]!.heRef).toBe("כתובות, ב., א");
    expect(s.target.end).toBe(24);
  });

  it("a siman found by a text book's headings: the line under the heading, not the heading (control: this one was right)", () => {
    const mish = ref("mish", "משכנות יעקב", "otzaria");
    const lines = ["<h1>משכנות יעקב</h1>", "<h2>סימן כא</h2>", "שאלה ראשונה", "תשובה", "<h2>סימן כב</h2>", "שאלה שניה", "תשובה שניה"].map((text, index) => ({ index, text, heading: /^<h(\d)/.exec(text) ? Number(/^<h(\d)/.exec(text)![1]) : null }));
    const lib: CitationLibrary = { catalog: [{ book: mish }], index: (b) => buildHeadingsIndex(b, lines) };
    const s = run('וראיתי בספר [משכנות יעקב סי\' כ"ב] שכתב', {}, lib).suggestions[0]!;
    expect(s.target.book.key).toBe("mish");
    expect(s.target.line).toBe(5);
  });
});

describe("C19 — the anchor: the commentator's name is in it, an unmatched bracket never is", () => {
  // anchors are written only where the record may carry one: "ציטוט בטקסט" here (every target of the fixture is Sefaria's)
  const anchorOf = (text: string, key?: string) => {
    const s = run(text, { citationType: "inline-linker" }).suggestions.find((x) => !key || x.target.book.key === key)!;
    return text.slice(s.anchor!.rawStart, s.anchor!.rawEnd);
  };
  it.each([
    ['ועיין רשב"ם בבא בתרא קכא. ושם', 'רשב"ם בבא בתרא קכא.'],
    ["ועיין תוס' ברכות ב. ושם", "תוס' ברכות ב."],
    ["ועיין בתוס' ברכות ב. ושם", "בתוס' ברכות ב."],
    ['ועיין (רשב"ם בבא בתרא קכא.) ושם', 'רשב"ם בבא בתרא קכא.'],
    ['ועיין רשב"ם (בבא בתרא קכא.) ושם', 'רשב"ם (בבא בתרא קכא.)'],
    ["ועיין תוס' (ברכות ב.) ושם", "תוס' (ברכות ב.)"],
  ])("%s → %s", (text, want) => expect(anchorOf(text)).toBe(want));

  it.each([
    ["ועיין ברכות (יג: ושם) ועוד", "ברכות (יג: ושם)"],
    ['ועיין ברכות (דף יג: ע"ש) ושם', 'ברכות (דף יג: ע"ש)'],
    ["ועיין ברכות [יג: ושם ועוד הרבה מאד מאד", "ברכות"],
    ["ועיין ברכות (דף יג:) ושם", "ברכות (דף יג:)"],
  ])("%s → %s (a bracket in the anchor is closed in it)", (text, want) => expect(anchorOf(text, B.ber.key)).toBe(want));

  it("an anchor never reaches over a second citation in the same bracket (found by the real-DB benchmark: 'במנחות (י\"א: ובכורות ג'.)')", () => {
    for (const text of ['הביא בשבת (י"א: וברכות ג\'.) מחלוקת', 'ומייתי לה בשבת (פרק ח\' דף י"ב ב\' וברכות ד\' י"ג) הכל']) {
      const r = run(text, { citationType: "inline-linker" });
      expect(r.suggestions.map((s) => s.target.book.key).sort(), text).toEqual([B.ber.key, B.shab.key]);
      const first = r.suggestions.find((s) => s.target.book.key === B.shab.key)!;
      expect(text.slice(first.anchor!.rawStart, first.anchor!.rawEnd)).toBe("בשבת");
    }
  });
});

describe("C20 — a siman of a book in parts of the Shulchan Aruch: the part the context names", () => {
  // the shape of "משכנות יעקב" in seforim.db (no structured heRef: its headings): a part of יורה דעה whose simanim are written
  // "<n> שאלה", then glosses on חושן משפט with "סימן מג" — the only heading the headings index reads as siman 43
  const mish = ref("mish", "משכנות יעקב", "otzaria");
  const lines = ["<h1>משכנות יעקב</h1>", "<h2>מחלק יורה דעה</h2>", "<h3>סימן מב</h3>", "שאלה", "תשובה", "<h2>הגהות השייכים לחלק חושן משפט</h2>", "<h3>סימן מג</h3>", "הגהה", "הגהה שניה"].map((text, index) => ({ index, text, heading: /^<h(\d)/.exec(text) ? Number(/^<h(\d)/.exec(text)![1]) : null }));
  const lib: CitationLibrary = { catalog: [{ book: mish }], index: (b) => buildHeadingsIndex(b, lines) };
  const go = (text: string | string[]) => run(text, {}, lib);

  it("the context is יורה דעה: no link to the siman of חושן משפט, and the reason is listed", () => {
    const r = go('ועיין ביורה דעה סימן קצו, וראיתי [במשכנות יעקב סי\' מ"ג] שכתב');
    expect(r.suggestions.filter((s) => s.target.book.key === "mish")).toEqual([]);
    expect(r.unmatched.flatMap((u) => u.reasons.map((x) => x.code))).toContain("citations/part-mismatch");
  });

  it("…also when the part was named a few lines before", () => {
    const r = go(["והנה בהלכות נדה ביו\"ד סימן קצ\"ו כתב", "ועוד שם", 'וראיתי במשכנות יעקב סי\' מ"ג שכתב']);
    expect(r.suggestions.filter((s) => s.target.book.key === "mish")).toEqual([]);
  });

  it("the context is חושן משפט: the siman, as before", () => {
    const s = go('ועיין בחושן משפט סימן ז, וראיתי במשכנות יעקב סי\' מ"ג שכתב').suggestions.find((x) => x.target.book.key === "mish")!;
    expect(s.target.line).toBeGreaterThanOrEqual(6);
    expect(s.confidence).not.toBe("possible");
  });

  it("no part in the context: the siman, at most 'possible' (the book has several parts; which one is meant is not written)", () => {
    const s = go('וראיתי במשכנות יעקב סי\' מ"ג שכתב').suggestions.find((x) => x.target.book.key === "mish")!;
    expect(s.confidence).toBe("possible");
    expect(s.warnings.map((w) => w.code)).toContain("citations/part-undecided");
  });

  it("the part written after the name decides too: 'משכנות יעקב יו\"ד סי' מ\"ג' is not חושן משפט", () => {
    expect(go('וראיתי במשכנות יעקב יו"ד סי\' מ"ג שכתב').suggestions.filter((s) => s.target.book.key === "mish")).toEqual([]);
  });

  it("a book of one part is not touched (control)", () => {
    const one = lines.filter((l) => l.index < 1 || l.index > 4).map((l, index) => ({ ...l, index }));
    const solo: CitationLibrary = { catalog: [{ book: mish }], index: (b) => buildHeadingsIndex(b, one) };
    const s = run('ועיין ביורה דעה, וראיתי במשכנות יעקב סי\' מ"ג שכתב', {}, solo).suggestions.find((x) => x.target.book.key === "mish")!;
    expect(s.confidence).not.toBe("possible");
  });
});

describe("C21 — forms that were missed", () => {
  const one = (text: string, key: string) => run(text).suggestions.filter((s) => s.target.book.key === key);
  const lineOf = (book: { key: string }, heRef: string) => BOOKS.find((b) => b.book.key === book.key)!.refs.findIndex((r) => r.heRef === heRef);

  it("'שמ\"א ג ד' outside brackets: the verse (a name that is also a numeral, so at most 'possible')", () => {
    const [s] = one('כמו שכתוב שמ"א ג ד ועוד', B.sam1.key);
    expect(s!.target.line).toBe(lineOf(B.sam1, "שמואל א, ג, ד"));
    expect(s!.confidence).toBe("possible");
    // after a place word it is a siman: "סי' שמ"א ג ד" is no book of Samuel
    expect(one('ועיין סי\' שמ"א ג ד ושם', B.sam1.key)).toEqual([]);
  });

  it("'בראשית א.' — a chapter alone outside brackets, where the words end: the whole chapter, 'possible'", () => {
    for (const text of ["כמו שכתוב בבראשית א. ועוד", "כמו שכתוב בראשית א; ועוד", "וכך כתוב בראשית ב"]) {
      const [s] = one(text, B.gen.key);
      expect(s, text).toBeDefined();
      expect(s!.confidence).toBe("possible");
      expect(s!.citedSpan ?? s!.target).toBeDefined();
    }
    // mid-sentence it is no place ("בראשית א ועוד"), nor after "פרשת"
    expect(one("כמו שכתוב בראשית א ועוד", B.gen.key)).toEqual([]);
    expect(one("ובפרשת בראשית א.", B.gen.key)).toEqual([]);
  });

  it("'ויקרא רבה ג': a parasha of a midrash rabbah by a bare numeral, 'possible'", () => {
    const [s] = one("ועיין ויקרא רבה ג ושם", B.levR.key);
    expect(s!.target.line).toBe(lineOf(B.levR, "ויקרא רבה, ג, א"));
    expect(s!.confidence).toBe("possible");
  });

  it("'שבת לא.-לב:': a range of dafim, from amud א of לא to amud ב of לב", () => {
    const [s] = one("ועיין שבת לא.-לב: ושם", B.shab.key);
    expect(s!.target.line).toBe(lineOf(B.shab, "שבת, לא., א"));
    expect(s!.citedSpan).toEqual({ line: lineOf(B.shab, "שבת, לא., א"), end: lineOf(B.shab, "שבת, לב:, ג") });
    expect(s!.heRef2).toBe("שבת לא.-לב:");
    // in "ציטוט בטקסט" the range is the target itself (C17)
    const inline = run("ועיין שבת לא.-לב: ושם", { citationType: "inline-linker" }).suggestions.find((x) => x.target.book.key === B.shab.key)!;
    expect(inline.target.end).toBe(lineOf(B.shab, "שבת, לב:, ג"));
  });

  it("'ברכות יג׃': sof pasuq written for the colon of the amud", () => {
    const [s] = one("ועיין ברכות יג׃ ושם", B.ber.key);
    expect(s!.target.line).toBe(lineOf(B.ber, "ברכות, יג:, א"));
    expect(s!.confidence).toBe("certain");
    // a vocalised verse that ends with a numeral-like word keeps its sof pasuq as the end of the verse
    expect(one("וַיֹּאמֶר בְּרָכוֹת לֹא׃", B.ber.key)).toEqual([]);
  });

  /*
   * V7 round 2 (C21, the two forms the review listed as still missed): a range of dafim with no amud at one end or at both ("שבת לא-לב"),
   * and "ושם ע"ב ד"ה" after a daf cited with no commentator. The forms are the review's own (docs/reviews/QA_V7_PR2.md, C21).
   */
  it("'שבת לא-לב': a range of whole dafim, from amud א of the first to amud ב of the last; one amud at one end only", () => {
    const first = lineOf(B.shab, "שבת, לא., א");
    for (const [text, end] of [
      ["ועיין שבת לא-לב ושם", "שבת, לב:, ג"],
      ["ועיין שבת דף לא-לב ושם", "שבת, לב:, ג"],
      ["ועיין (שבת לא - לב) ושם", "שבת, לב:, ג"],
      ["ועיין שבת לא.-לב ושם", "שבת, לב:, ג"],
      ["ועיין שבת לא-לב: ושם", "שבת, לב:, ג"],
    ] as const) {
      const [s] = one(text, B.shab.key);
      expect(s, text).toBeDefined();
      expect(s!.target.line, text).toBe(first);
      expect(s!.citedSpan, text).toEqual({ line: first, end: lineOf(B.shab, end) });
    }
    const [s] = one("ועיין שבת לא.-לב ושם", B.shab.key);
    expect(s!.heRef2).toBe("שבת לא.-לב");
    // a start after amud ב: from that amud
    const [b] = one("ועיין שבת לא:-לב ושם", B.shab.key);
    expect(b!.target.line).toBe(lineOf(B.shab, "שבת, לא:, א"));
  });

  it("two numerals that are everyday words with no hyphen are not a range (control)", () => {
    expect(one("ועיין שבת לא לב ושם", B.shab.key).filter((s) => s.citedSpan?.end === lineOf(B.shab, "שבת, לב:, ג"))).toEqual([]);
    // and the hyphen does not join a smaller number, or one too far away
    expect(one("ועיין שבת לב-לא ושם", B.shab.key).some((s) => s.citedSpan?.end === lineOf(B.shab, "שבת, לב:, ג"))).toBe(false);
  });

  it("'ושם ע\"ב ד\"ה' after a daf cited with no commentator: the other amud of that daf, 'possible' (like 'ברכות יג: ד\"ה', B7)", () => {
    const r = run('ועיין ברכות יג. ושם ע"ב ד"ה והא ועוד');
    const to = r.suggestions.filter((s) => s.target.book.key === B.ber.key).sort((a, b) => a.target.line - b.target.line);
    expect(to.map((s) => heRefOf(B.ber, s.target.line))).toEqual(["ברכות, יג., א", "ברכות, יג:, א"]);
    expect(to[0]!.confidence).toBe("certain");
    expect(to[1]!.confidence).toBe("possible");
    expect(to[1]!.rules).toContain("citations.dibur-no-commentator");
    // after a commentator's citation it is still his words on the other amud (control)
    const tos = run('ועיין תוס\' ברכות יג. ד"ה והא ושם ע"ב ד"ה אלא').suggestions.filter((s) => s.target.book.key === B.tosBer.key);
    expect(tos.map((s) => heRefOf(B.tosBer, s.target.line)!.split(",")[1]!.trim())).toEqual(["יג.", "יג:"]);
  });

  it("'ברכות<sup>1</sup> יג:': a note's mark between the name and the place", () => {
    const text = "ועיין ברכות<sup>1</sup> יג: ושם";
    const [s] = one(text, B.ber.key);
    expect(s!.target.line).toBe(lineOf(B.ber, "ברכות, יג:, א"));
    expect(s!.confidence).toBe("certain");
  });
});
