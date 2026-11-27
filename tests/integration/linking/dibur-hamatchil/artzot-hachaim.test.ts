import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Link } from "../../../../src/core/links/model";
import { validateLink, type ValidationContext } from "../../../../src/core/links/validate";
import { countVisibleChars } from "../../../../src/core/text/offsets";
import { linkToRecord } from "../../../../src/formats/links-json/convert";
import { runDiburHamatchilEngine } from "../../../../src/linking/automatic/dibur-hamatchil";
import type { EngineBook, Suggestion } from "../../../../src/linking/automatic/types";

/*
 * Issue #43: the owner's build_artzot_hachaim_links.py (read as data, never run) links "ארצות החיים" with its two
 * commentaries — for every ס"ק (<h5>) of a commentary: its ד"ה (the first <b> of its first content line), found in
 * the base INSIDE the same סימן (<h3>) and סעיף (<h4>), a record from that base line to the ס"ק's content lines
 * (line_index_2 … line_index_2_end over its paragraphs) with `start` at the ד"ה in the raw base line.
 *
 * The tool does it with configuration of the existing ד"ה engine (docs/AUTOMATION_ENGINE.md §3.3): heading windows
 * (scope by every heading both books share), bold ד"ה extraction, the search ladder, item paragraphs and — new for this
 * case — `itemRanges`, the range on the commentary side. The data: real lines of the three books from
 * tests/fixtures/db/seforim-v7-mini.db with synthetic headings (tests/fixtures/linking/artzot-hachaim/README.md).
 *
 * EXPECTED is what the script writes for these files, worked by hand from its code (1-based lines, raw `start`), and it
 * is what the library's database holds for the same lines (README: base line, ס"ק range, visible anchor). The script
 * writes "linker", which the generator does not import (validate.ts export/linker); the library's file has
 * "commentary", and so does the tool.
 */
const DIR = "tests/fixtures/linking/artzot-hachaim/";
const HAMEIR = "המאיר לארץ על ארצות החיים";
const ERETZ = "ארץ יהודה על ארצות החיים";
const book = (title: string): EngineBook => ({
  book: { key: `db:${title}`, title, origin: "otzaria" },
  lines: readFileSync(`${DIR}${title}.txt`, "utf8")
    .replace(/\n$/, "")
    .split("\n")
    .map((text, index) => ({ index, text, heading: /^<h([1-6])/.test(text) ? Number(text[2]) : null })),
});
const base = book("ארצות החיים");

type Rec = { line_index_1: number; line_index_2: number; line_index_2_end?: number; start: number };
const EXPECTED: Record<string, Rec[]> = {
  [HAMEIR]: [
    { line_index_1: 4, line_index_2: 5, start: 33 }, // "מארבע" — the library's own record has start 33 too (anchor-point.json)
    { line_index_1: 12, line_index_2: 9, start: 5 },
    { line_index_1: 15, line_index_2: 13, start: 646 }, // "וצבור", late in the line
  ],
  [ERETZ]: [
    { line_index_1: 6, line_index_2: 5, line_index_2_end: 6, start: 5 },
    { line_index_1: 9, line_index_2: 10, line_index_2_end: 11, start: 5 },
    // the script runs the ס"ק to the next heading, so it also takes the book's closing "תם ונשלם" (line 16) — see below
    { line_index_1: 15, line_index_2: 15, line_index_2_end: 16, start: 5 },
  ],
};
/** the visible anchor offsets the library's database holds for these base lines, by commentary (README) */
const DB_ANCHOR: Record<string, Record<number, number>> = { [HAMEIR]: { 4: 28, 12: 0, 15: 611 }, [ERETZ]: { 6: 0, 9: 0, 15: 0 } };
const books = new Map([base, book(HAMEIR), book(ERETZ)].map((b) => [b.book.title, b]));
/** the export's checks with the books' real lengths and headings, for a private export (a submission would only add file-level checks) */
const ctx: ValidationContext = {
  purpose: "private",
  lineCount: (ref) => books.get(ref.title)?.lines.length,
  line: (ref, i) => {
    const l = books.get(ref.title)?.lines[i];
    return l && { exists: true, heading: l.heading, anchorLength: l.text.length };
  },
};

const asLink = (s: Suggestion): Link => ({ id: s.id, status: "new", provenance: "auto", source: s.source, target: s.target, declaredType: s.declaredType, heRef2: s.heRef2, ...(s.anchor && { anchor: s.anchor }) });
const run = (title: string, itemRanges: boolean) => runDiburHamatchilEngine(book(title), base, { itemRanges }).suggestions;
const records = (title: string, itemRanges = true) =>
  run(title, itemRanges)
    .map((s) => linkToRecord(asLink(s)) as unknown as Rec & Record<string, unknown>)
    .map((r) => ({ line_index_1: r.line_index_1, line_index_2: r.line_index_2, ...(r.line_index_2_end !== undefined && { line_index_2_end: r.line_index_2_end }), start: r.start as number }));

describe("issue #43: ארצות החיים and its commentaries, as build_artzot_hachaim_links.py links them", () => {
  it(`המאיר לארץ: every ס"ק on its base line, the anchor exactly where the script puts start`, () => {
    expect(records(HAMEIR)).toEqual(EXPECTED[HAMEIR]);
  });

  it(`ארץ יהודה: one record per ס"ק with a range over its paragraphs (itemRanges) — except the closing line`, () => {
    const got = records(ERETZ);
    expect(got.slice(0, 2)).toEqual(EXPECTED[ERETZ]!.slice(0, 2));
    // the one deliberate difference: "תם ונשלם" is the book's colophon, not a paragraph of the last ס"ק (dh/colophon)
    const { line_index_2_end: _e, ...lastWithoutEnd } = EXPECTED[ERETZ]![2]!;
    expect(got[2]).toEqual(lastWithoutEnd);
    expect(got).toHaveLength(3);
  });

  it(`without itemRanges a ס"ק's paragraphs are links of their own (the default stays as it was)`, () => {
    const got = records(ERETZ, false);
    expect(got.map((r) => [r.line_index_1, r.line_index_2, r.line_index_2_end])).toEqual([
      [6, 5, undefined],
      [6, 6, undefined],
      [9, 10, undefined],
      [9, 11, undefined],
      [15, 15, undefined],
    ]);
  });

  it("the anchors are the ones the library's database holds for these lines (visible offsets)", () => {
    for (const title of [HAMEIR, ERETZ])
      for (const s of run(title, true)) {
        const line = base.lines[s.source.line]!.text;
        expect(countVisibleChars(line, s.anchor!.rawStart)).toBe(DB_ANCHOR[title]![s.source.line + 1]);
      }
  });

  it("every record is base → commentary, \"commentary\", certain or high, and passes the export's checks", () => {
    for (const title of [HAMEIR, ERETZ])
      for (const s of run(title, true)) {
        expect(s.source.book.title).toBe("ארצות החיים");
        expect(s.target.book.title).toBe(title);
        expect(s.declaredType).toBe("commentary");
        expect(["certain", "high"]).toContain(s.confidence);
        const errors = validateLink(asLink(s), ctx).filter((p) => p.severity === "error");
        expect(errors).toEqual([]);
      }
  });

  it(`the scope is the סימן and סעיף: a ד"ה that also stands in another סעיף is found in its own`, () => {
    // "נשים" (ארץ יהודה, סימן יז סעיף ב) — the base's other lines also say נשים; the window is the סעיף's line only
    const s = run(ERETZ, true).find((x) => x.target.line === 9)!;
    expect(s.rules).toContain("dh/window-heading");
    expect(s.source.line).toBe(8);
  });
});
