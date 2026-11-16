import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { headingLevel } from "../../../../src/core/text/html";
import { countVisibleChars } from "../../../../src/core/text/offsets";
import { OtzariaDbReader } from "../../../../src/database/otzaria/reader";
import { bytesSource } from "../../../../src/database/sqlite/lazy/byte-source";
import { runFootnotesEngine } from "../../../../src/linking/automatic/footnotes";
import type { EngineBook } from "../../../../src/linking/automatic/types";
import { benchFromLineNotes, score } from "./line-note-bench";

/*
 * The footnotes engine on REAL library data.
 *
 * 1. tests/fixtures/linking/footnotes/midrash-vayisau.json — the only main/notes pair of the library
 *    linked with FOOTNOTES (scripts/fixtures/make_footnotes_fixture.py): Hebrew-letter <sup>
 *    markers, numbering that restarts in every chapter, one note cited from two places, and the
 *    generator's own <sup class="footnote-marker"> of ANOTHER (merged) notes book in the same lines.
 *    The library's 16 links are the truth.
 * 2. seforim-v7-mini.db, book 8441 — its merged "הערות על" companion rebuilt from line_note: the
 *    truth is exact down to the character (line-note-bench.ts).
 */
interface FixtureBook {
  title: string;
  lines: { index: number; text: string; heRef: string | null }[];
}
const fx = JSON.parse(readFileSync("tests/fixtures/linking/footnotes/midrash-vayisau.json", "utf8")) as {
  main: FixtureBook;
  notes: FixtureBook;
  footnotesLinks: { mainLine: number; notesLine: number }[];
};
const asBook = (b: FixtureBook, key: string): EngineBook => ({
  book: { key, title: b.title, origin: "otzaria" },
  lines: b.lines.map((l) => ({ index: l.index, text: l.text, heading: headingLevel(l.text), heRef: l.heRef })),
});
const main = asBook(fx.main, "db:main");
const notes = asBook(fx.notes, "db:notes");
const truth = fx.footnotesLinks.map((l) => `${l.mainLine}>${l.notesLine}`).sort();
const got = (opts: Parameters<typeof runFootnotesEngine>[2]) =>
  runFootnotesEngine(main, notes, opts).suggestions.map((s) => `${s.source.line}>${s.target.line}`).sort();

describe("מדרש ויסעו ↔ הערות באותיות: the library's FOOTNOTES links", () => {
  it("finds exactly the 16 links, in every chapter mode and with both alignments", () => {
    expect(truth.length).toBe(16);
    expect(got({})).toEqual(truth);
    expect(got({ chapterSplit: "reset" })).toEqual(truth);
    expect(got({ chapterSplit: "reset", chapterAlignment: "greedy" })).toEqual(truth);
    expect(got({ chapterSplit: "headings" })).toEqual(truth);
  });

  it("chapters come from the headings; repeated citations are the only ones left for review", () => {
    const res = runFootnotesEngine(main, notes);
    expect(res.suggestions.filter((s) => s.confidence === "certain").length).toBe(14);
    expect(res.suggestions.filter((s) => s.confidence === "high").map((s) => s.rules.includes("repeat"))).toEqual([true, true]);
    expect(res.notes.find((n) => n.code === "footnotes/chapters")!.text).toContain("3 פרקים");
  });

  it("anchors are the printed letters, never the inline-note markers of the merged book", () => {
    const res = runFootnotesEngine(main, notes);
    for (const s of res.suggestions) {
      const raw = main.lines[s.source.line]!.text.slice(s.anchor!.rawStart, s.anchor!.rawEnd);
      expect(raw).toMatch(/^<sup>[א-ת]<\/sup>$/);
      expect(s.anchor!.label).toBe(raw.slice(5, 6));
      expect(s.heRef2.endsWith(` אות ${s.anchor!.label}`)).toBe(true);
    }
    expect(res.notes.map((n) => n.code)).toContain("footnotes/inline-markers-skipped");
    // the notes title is "הערות באותיות על …", not the merged "הערות על …" form
    expect(res.notes.map((n) => n.code)).not.toContain("footnotes/companion-merged");
  });
});

describe("seforim-v7-mini.db book 8441: a merged companion rebuilt from line_note", () => {
  let lines: Awaited<ReturnType<OtzariaDbReader["lines"]>>;
  beforeAll(async () => {
    const reader = await OtzariaDbReader.open(bytesSource(new Uint8Array(readFileSync("tests/fixtures/db/seforim-v7-mini.db"))));
    lines = await reader.lines(8441);
  });

  it("every note found, every anchor ends exactly at the generator's charPos", () => {
    for (const withHeadings of [false, true]) {
      const b = benchFromLineNotes("הלכות גדולות כתובות", lines, withHeadings);
      const s = score(b, runFootnotesEngine(b.main, b.notes, { includeInlineNoteMarkers: true }));
      expect(s.truth).toBeGreaterThan(500);
      expect(s).toMatchObject({ precision: 1, recall: 1, anchorsExact: s.truth, certainCorrect: s.certain });
    }
  });

  it("the anchor end counted the generator's way is charPos (independent check)", () => {
    const b = benchFromLineNotes("הלכות גדולות כתובות", lines, false);
    const res = runFootnotesEngine(b.main, b.notes, { includeInlineNoteMarkers: true });
    const s = res.suggestions[0]!;
    expect(countVisibleChars(b.main.lines[s.source.line]!.text, s.anchor!.rawEnd)).toBe(b.truth.get(s.target.line)!.charPos);
  });
});
