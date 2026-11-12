import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { sefariaOwnedOf } from "../../../src/core/links/sefaria-owned";
import { validateLink, type ValidationContext } from "../../../src/core/links/validate";
import { headingLevel } from "../../../src/core/text/html";
import { runEngine, type EngineBook, type EngineId, type Suggestion } from "../../../src/linking/automatic";
import { buildRefIndex, runCitationsEngine, type CitationLibrary, type RefLine } from "../../../src/linking/automatic/citations";

/*
 * Product audit F1: the engines and the export must answer "is this a Sefaria book" with ONE rule.
 * A base whose origin is "otzaria" (a text file, an Otzaria database book) but which the library's
 * sync treats as Sefaria's (its title is in the library's list) got a word anchor with an end from
 * dibur-hamatchil, and the export refuses such an anchor in every mode (sefaria/anchor-range). Here
 * the engine output goes through the export validation with the same predicate.
 */
const BASE: BookRef = { key: "s1:בראשית.txt", title: "בראשית", origin: "otzaria" };
const COMM: BookRef = { key: "s1:ביאור חדש על בראשית.txt", title: "ביאור חדש על בראשית", origin: "otzaria" };
const NOTES: BookRef = { key: "s1:הערות על בראשית.txt", title: "הערות על בראשית", origin: "otzaria" };

const GEN1 = ["בראשית ברא אלהים את השמים ואת הארץ.", "והארץ היתה תהו ובהו וחשך על פני תהום ורוח אלהים מרחפת על פני המים.", "ויאמר אלהים יהי אור ויהי אור.", "וירא אלהים את האור כי טוב ויבדל אלהים בין האור ובין החשך."];
const DH = ["בראשית ברא", "תהו ובהו", "יהי אור", "כי טוב"];
const HEB = ["א", "ב", "ג", "ד"];
const lines = (texts: readonly string[]) => texts.map((text, index) => ({ index, text, heading: headingLevel(text) }));
const base: EngineBook = { book: BASE, lines: lines(["<h1>בראשית</h1>", "<h2>פרק א</h2>", ...GEN1]) };
const commentary: EngineBook = {
  book: COMM,
  lines: lines(["<h1>ביאור חדש על בראשית</h1>", "<h2>פרק א</h2>", ...DH.flatMap((d, i) => [`<h3>פסוק ${HEB[i]}</h3>`, `<b>${d}</b> - ביאור: הסבר קצר.`])]),
};

/** what the export checks, with the predicate the engines were given */
const ctxFor = (owned: (b: BookRef) => boolean, purpose: "submission" | "private"): ValidationContext => ({
  lineCount: () => 20,
  line: (b, i) => {
    const text = (b.key === BASE.key ? base : b.key === COMM.key ? commentary : notes).lines[i]?.text;
    return text === undefined ? undefined : { exists: true, heading: headingLevel(text), anchorLength: text.length };
  },
  sefariaOwned: owned,
  purpose,
});
const asLink = (s: Suggestion): Link => ({ id: s.id, status: "new", provenance: "auto", source: s.source, target: s.target, declaredType: s.declaredType, heRef2: s.heRef2 || "x", ...(s.anchor && { anchor: s.anchor }) });
const sefariaCodes = (ss: readonly Suggestion[], owned: (b: BookRef) => boolean, purpose: "submission" | "private" = "private") =>
  ss.flatMap((s) => validateLink(asLink(s), ctxFor(owned, purpose)).filter((p) => p.code.startsWith("sefaria/") && p.severity === "error").map((p) => p.code));

const notes: EngineBook = { book: NOTES, lines: lines(["<h1>הערות על בראשית</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה.", "(2) הערה שנייה."]) };
const withMarks: EngineBook = { book: BASE, lines: lines(["<h1>בראשית</h1>", "<h2>פרק א</h2>", "בראשית ברא (1) אלהים.", "והארץ היתה (2) תהו ובהו."]) };

describe("one rule for 'Sefaria book' in the engines and the export (audit F1)", () => {
  const owned = sefariaOwnedOf([BASE.key]);

  it("the bug: without the library's answer, dibur-hamatchil anchors the base words and the export refuses every link", () => {
    const r = runEngine("dibur-hamatchil", commentary, base, {});
    expect(r.suggestions.length).toBe(4);
    expect(r.suggestions.every((s) => s.anchor?.rawEnd !== undefined)).toBe(true);
    expect(sefariaCodes(r.suggestions, owned)).toContain("sefaria/anchor-range");
  });

  it("with it, dibur-hamatchil writes from the commentary without an anchor, and nothing is an error even for private use", () => {
    const r = runEngine("dibur-hamatchil", commentary, base, { sefariaOwned: [BASE.key] });
    expect(r.suggestions.length).toBe(4);
    expect(r.suggestions.every((s) => !s.anchor && s.source.book.key === COMM.key && s.target.end === undefined)).toBe(true);
    expect(r.notes.map((n) => n.code)).toContain("dh/anchors-sefaria");
    expect(sefariaCodes(r.suggestions, owned)).toEqual([]);
    // for a submission only the ref the export fills from the database (or the user) is missing — never the anchor
    expect(new Set(sefariaCodes(r.suggestions, owned, "submission"))).toEqual(new Set(["sefaria/ref2-required"]));
  });

  it("a base the library does not treat as Sefaria's keeps its anchor", () => {
    const r = runEngine("dibur-hamatchil", commentary, base, { sefariaOwned: [] });
    expect(r.suggestions.every((s) => s.anchor !== undefined)).toBe(true);
    expect(sefariaCodes(r.suggestions, sefariaOwnedOf([]), "submission")).toEqual([]);
  });

  it.each<[EngineId, EngineBook, EngineBook]>([
    ["footnotes", withMarks, notes],
    ["pattern", withMarks, notes],
  ])("%s: no anchor on a Sefaria side", (engine, source, target) => {
    const options = engine === "pattern" ? { regex: "\\((\\d+)\\)", mode: "line" } : {};
    const before = runEngine(engine, source, target, options);
    const after = runEngine(engine, source, target, { ...options, sefariaOwned: [BASE.key] });
    if (engine === "footnotes") expect(before.suggestions.some((s) => s.anchor)).toBe(true);
    expect(after.suggestions.some((s) => s.anchor)).toBe(false);
    expect(sefariaCodes(after.suggestions, owned)).toEqual([]);
  });

  it("citations: no anchor and no range into a book the library treats as Sefaria's", () => {
    const citing: EngineBook = { book: COMM, lines: lines(["<h1>ביאור חדש על בראשית</h1>", "כמו שכתוב (בראשית א) וכן (בראשית א, ב) הלאה."]) };
    // בראשית with heRefs as the database has them (origin "otzaria": a book the database did not mark as Sefaria's)
    const refs: RefLine[] = [{ index: 0, heRef: null }, { index: 1, heRef: null }, ...GEN1.map((_, i) => ({ index: i + 2, heRef: `בראשית, א, ${HEB[i]}` }))];
    const library: CitationLibrary = { catalog: [{ book: BASE }], index: (b) => buildRefIndex(b, refs), heRefAt: (_b, l) => refs[l]?.heRef ?? null };
    const before = runCitationsEngine(citing, library, {});
    expect(before.suggestions.some((s) => s.anchor) && before.suggestions.some((s) => s.target.end !== undefined)).toBe(true);
    const r = runCitationsEngine(citing, library, { sefariaOwned: [BASE.key] });
    expect(r.suggestions.length).toBe(before.suggestions.length);
    for (const s of r.suggestions) {
      expect(s.anchor).toBeUndefined();
      expect(s.target.end).toBeUndefined();
    }
    expect(sefariaCodes(r.suggestions, owned)).toEqual([]);
  });
});