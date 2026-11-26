import { describe, expect, it } from "vitest";
import type { Link } from "../../../../src/core/links/model";
import { validateLink, type ValidationContext } from "../../../../src/core/links/validate";
import { AliasIndex, citationGate, citationHintStrength } from "../../../../src/linking/automatic/citations";
import { B, heRefOf, LIB, run } from "./v7-fixture";

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
