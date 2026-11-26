import { describe, expect, it } from "vitest";
import { headingLevel } from "../../../../src/core/text/html";
import { runEngine } from "../../../../src/linking/automatic";
import { sanitizeStoredOptions, toEngineOptions } from "../../../../src/linking/automatic/option-specs";
import type { EngineBook, EngineResult } from "../../../../src/linking/automatic/types";
import { runHeadingsEngine } from "../../../../src/linking/automatic/headings";

/*
 * v3's "לפי כותרות" had three ways to match (`structuralMatch` mode content | structural | subsections) and "פסקאות רגילות כסעיפים"
 * (`trySplit`, F-095, F-097). V7 kept one way — aligning the kind and number of every level, with names by similarity — which is v3's
 * "structural" and more. These are the other three, as options of the same engine (no second engine). Synthetic books, neutral words.
 */
function book(key: string, title: string, lines: readonly string[]): EngineBook {
  return { book: { key, title, origin: "otzaria" }, lines: lines.map((text, index) => ({ index, text, heading: headingLevel(text) })) };
}
const at = (r: EngineResult, line: number) => r.suggestions.find((s) => s.source.line === line);
const unmatchedAt = (r: EngineResult, line: number) => r.unmatched.find((u) => u.line === line);
const span = (r: EngineResult, line: number) => {
  const s = at(r, line);
  return s ? [s.target.line, s.target.end ?? null] : null;
};

describe('headingMatch "content": the place of a line is the base heading with the same TEXT (v3 "לפי תוכן הכותרת", F-095)', () => {
  const base = book("b", "ספר הבסיס", [
    "<h1>ספר הבסיס</h1>", //   0
    "<h2>פרק ג</h2>", //        1
    "<h3>ענין הברכות</h3>", //  2
    "אלפא בטא גמא", //          3
    "דלתא הא וו", //            4
    "<h2>פרק ד</h2>", //        5
    "<h3>ענין הקרבנות</h3>", // 6
    "זין חית טית", //           7
    "יוד כף למד", //            8
  ]);
  // the commentary numbers its chapters one off from this base (another edition), but names its sections the same way
  const comm = book("c", "ביאור על ספר הבסיס", ["<h1>ביאור על ספר הבסיס</h1>", "<h2>פרק ג</h2>", "<h3>ענין הקרבנות</h3>", "דברים על הקרבנות", "<h3>ענין הבירכות</h3>", "דברים על הברכות"]);

  it("structure (the default) trusts the chapter number: the line falls on the whole of פרק ג, at most 'possible'", () => {
    const r = runHeadingsEngine(comm, base);
    expect(span(r, 3)).toEqual([3, 4]);
    expect(at(r, 3)!.confidence).toBe("possible");
  });

  it("content trusts the heading's text: the section of that name under another parent — 'high', with a warning that says where", () => {
    const r = runHeadingsEngine(comm, base, { headingMatch: "content" });
    expect(span(r, 3)).toEqual([7, 8]);
    expect(at(r, 3)!.confidence).toBe("high");
    expect(at(r, 3)!.reasons.some((x) => x.code === "heading/same-name")).toBe(true);
    expect(at(r, 3)!.warnings.find((w) => w.code === "heading/content-other-parent")?.text).toContain("פרק ד");
    expect(at(r, 3)!.rules).toContain("headings.content");
  });

  it("a text that is close, not equal, is matched below 'certain' (v3's flexible spelling); same text and same parent is certain", () => {
    const r = runHeadingsEngine(comm, base, { headingMatch: "content" });
    // "ענין הבירכות" ~ "ענין הברכות" (plene spelling), under the same "פרק ג"
    expect(span(r, 5)).toEqual([3, 4]);
    expect(at(r, 5)!.reasons.some((x) => x.code === "heading/similar-name")).toBe(true);
    expect(at(r, 5)!.confidence).not.toBe("certain");
    const same = book("c2", "ביאור על ספר הבסיס", ["<h2>פרק ד</h2>", "<h3>ענין הקרבנות</h3>", "דברים"]);
    expect(at(runHeadingsEngine(same, base, { headingMatch: "content" }), 2)!.confidence).toBe("certain");
  });

  it("a heading text the base does not have is unmatched, with the reason", () => {
    const other = book("c3", "ביאור על ספר הבסיס", ["<h1>ביאור על ספר הבסיס</h1>", "<h2>פרק ג</h2>", "<h3>ענין אחר לגמרי</h3>", "דברים"]);
    const r = runHeadingsEngine(other, base, { headingMatch: "content" });
    expect(r.suggestions).toEqual([]);
    expect(unmatchedAt(r, 3)?.reasons[0]?.code).toBe("heading/not-found");
  });
});

describe('headingMatch "leaves": only the deepest sections, never a coarse or partial place (v3 "רק תתי־סעיפים", F-095)', () => {
  const base = book("b", "בראשית", ["<h1>בראשית</h1>", "<h2>פרק א</h2>", "(א) אלפא בטא", "(ב) גמא דלתא", "(ג) הא וו"]);
  const comm = book("c", "ביאור על בראשית", [
    "<h2>פרק א</h2>", //               0
    "פתיחה לכל הפרק", //               1  under a heading that has sub-headings
    "<h3>פסוק ב</h3>", //              2
    "גמא. פירוש", //                   3
    "<h3>פסוק ט</h3>", //              4
    "פירוש לפסוק שאין בבסיס", //       5  partial: only the chapter is found
  ]);

  it("structure links the opening and the missing verse to the whole chapter", () => {
    const r = runHeadingsEngine(comm, base);
    expect(span(r, 1)).toEqual([2, 4]);
    expect(span(r, 3)).toEqual([3, null]);
    expect(span(r, 5)).toEqual([2, 4]);
  });

  it("leaves keeps the exact verse, and lists the other two as unmatched with the reason", () => {
    const r = runHeadingsEngine(comm, base, { headingMatch: "leaves" });
    expect(r.suggestions.map((s) => s.source.line)).toEqual([3]);
    expect(span(r, 3)).toEqual([3, null]);
    expect(unmatchedAt(r, 1)?.reasons[0]?.code).toBe("heading/not-leaf");
    expect(unmatchedAt(r, 5)?.reasons[0]?.code).toBe("heading/not-leaf");
  });
});

describe('paragraphsAsSections: the paragraphs under a heading are its sub-sections when the counts are equal (v3 "trySplit", F-097)', () => {
  const base = book("b", "בראשית", ["<h2>פרק א</h2>", "(א) אלפא", "(ב) בטא", "(ג) גמא", "<h2>פרק ב</h2>", "(א) דלתא", "(ב) הא"]);
  // three paragraphs under פרק א (three verses in the base); one under פרק ב (two verses): no split there
  const comm = book("c", "ביאור על בראשית", ["<h2>פרק א</h2>", "פירוש ראשון", "פירוש שני", "פירוש שלישי", "<h2>פרק ב</h2>", "פירוש יחיד"]);

  it("off (the default): every paragraph goes to the whole chapter", () => {
    const r = runHeadingsEngine(comm, base);
    expect([1, 2, 3, 5].map((l) => span(r, l))).toEqual([[1, 3], [1, 3], [1, 3], [5, 6]]);
  });

  it("on: paragraph k → verse k, never above 'possible' (an inference, not a match), and a count that differs is not split", () => {
    const r = runHeadingsEngine(comm, base, { paragraphsAsSections: true });
    expect([1, 2, 3, 5].map((l) => span(r, l))).toEqual([[1, null], [2, null], [3, null], [5, 6]]);
    for (const l of [1, 2, 3]) {
      expect(at(r, l)!.confidence).toBe("possible");
      expect(at(r, l)!.warnings.some((w) => w.code === "heading/paragraph-split")).toBe(true);
      expect(at(r, l)!.rules).toContain("headings.paragraph-split");
    }
    expect(at(r, 5)!.warnings.some((w) => w.code === "heading/paragraph-split")).toBe(false);
    expect(r.notes.some((n) => n.code === "heading/paragraph-split")).toBe(true);
  });

  it("with leaves: a split paragraph is a deepest section, so it is kept; the unsplit one is not", () => {
    const r = runHeadingsEngine(comm, base, { headingMatch: "leaves", paragraphsAsSections: true });
    expect(r.suggestions.map((s) => s.source.line)).toEqual([1, 2, 3]);
    expect(unmatchedAt(r, 5)?.reasons[0]?.code).toBe("heading/not-leaf");
  });

  it("sub-headings in the base count as sections too", () => {
    const tagged = book("b2", "בראשית", ["<h2>פרק א</h2>", "<h3>פסוק א</h3>", "אלפא", "<h3>פסוק ב</h3>", "בטא"]);
    const two = book("c2", "ביאור על בראשית", ["<h2>פרק א</h2>", "פירוש ראשון", "פירוש שני"]);
    const r = runHeadingsEngine(two, tagged, { paragraphsAsSections: true });
    expect([1, 2].map((l) => span(r, l))).toEqual([[2, null], [4, null]]);
  });
});

describe("the modes are options of the one headings engine: the form and storage", () => {
  it("the form passes them; the defaults are not sent; storage keeps only valid values", () => {
    const r = toEngineOptions("headings", { headingMatch: "content", paragraphsAsSections: true });
    expect(r.errors).toEqual({});
    expect(r.options).toMatchObject({ headingMatch: "content", paragraphsAsSections: true });
    expect(toEngineOptions("headings", { headingMatch: "structure", paragraphsAsSections: false }).options).toEqual({});
    expect(sanitizeStoredOptions("headings", { headingMatch: "leaves", paragraphsAsSections: "yes" })).toEqual({ headingMatch: "leaves" });
    expect(sanitizeStoredOptions("headings", { headingMatch: "all" })).toEqual({});
  });

  it("runEngine passes them to the engine", () => {
    const base = book("b", "בראשית", ["<h2>פרק א</h2>", "(א) אלפא", "(ב) בטא"]);
    const comm = book("c", "ביאור על בראשית", ["<h2>פרק א</h2>", "פירוש ראשון", "פירוש שני"]);
    expect(runEngine("headings", comm, base, { paragraphsAsSections: true }).suggestions.map((s) => s.target.line)).toEqual([1, 2]);
  });
});

/*
 * v3 F-096 "התאמה גמישה לכתיב" (nikud and gershayim ignored, abbreviations of kind words, plene and defective spelling, small slips): in
 * V7 numbers are read by kind and value, so "סי' יב", "סימן י״ב" and "סִימָן יב" are one place; a NAME matches by similarity ≥ 0.85, below
 * "certain". The legacy parity table had no test for it.
 */
describe("flexible spelling of headings (v3 F-096), in the default mode", () => {
  const base = book("b", "ספר הבסיס", ["<h1>ספר הבסיס</h1>", "<h2>ענין הקרבנות</h2>", "<h3>סימן יב</h3>", "אלפא בטא", "<h2>ענין התפלה</h2>", "גמא דלתא"]);

  it("a kind word abbreviated, gershayim and nikud: the same place, certain", () => {
    for (const h of ["סי' יב", "סימן י״ב", "סִימָן יב"]) {
      const r = runHeadingsEngine(book("c", "ביאור", ["<h2>ענין הקרבנות</h2>", `<h3>${h}</h3>`, "פירוש"]), base);
      expect([span(r, 2), at(r, 2)?.confidence]).toEqual([[3, null], "certain"]);
    }
  });

  it("a name in plene spelling matches the defective one, at a small cost; a different name does not", () => {
    const r = runHeadingsEngine(book("c", "ביאור", ["<h2>ענין התפילה</h2>", "פירוש", "<h2>ענין אחר לגמרי</h2>", "פירוש"]), base);
    expect(span(r, 1)).toEqual([5, null]);
    expect(at(r, 1)!.reasons.some((x) => x.code === "heading/similar-name")).toBe(true);
    // align.ts: (1 − similarity) × 0.5; "התפילה" ~ "התפלה" is 0.94, so 0.97
    expect(at(r, 1)!.score).toBeLessThan(1);
    expect(at(r, 3)).toBeUndefined();
  });
});
