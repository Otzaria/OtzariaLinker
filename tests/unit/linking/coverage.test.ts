import { describe, expect, it } from "vitest";
import type { BookRef, Link, LinkSide } from "../../../src/core/links/model";
import { coverageOfLines, coverageSummary, unlinkedRanges, type CoverageBook } from "../../../src/linking/coverage";

/* Pure coverage rules (issue #17); the state accessor and the real-book run are in tests/integration/state/coverage.test.ts. */
const C: BookRef = { key: "c", title: "פירוש", origin: "otzaria" };
const B: BookRef = { key: "b", title: "בסיס", origin: "otzaria" };
const B2: BookRef = { key: "b2", title: "בסיס שני", origin: "otzaria" };
const side = (book: BookRef, line: number, end?: number): LinkSide => ({ book, line, ...(end !== undefined && { end }) });
let n = 0;
const link = (source: LinkSide, target: LinkSide, status: Link["status"] = "new"): Link => ({ id: `l${n++}`, status, provenance: "user", source, target, declaredType: "commentary", heRef2: "" });
const book = (lineCount: number, headings: number[] = [], unsuitable: number[] = []): CoverageBook => ({ owns: (r) => r.key === "c", lineCount, headings: new Set(headings), unsuitable: new Set(unsuitable) });

describe("coverageOfLines — the five buckets", () => {
  it("nothing linked: every line is unlinked except the headings, which are not suitable", () => {
    expect(coverageOfLines([], book(5, [0, 3]))).toEqual(["not-suitable", "unlinked", "unlinked", "not-suitable", "unlinked"]);
  });

  it("a link on either side of the file counts: the commentary as the source, or as the target", () => {
    const as = [link(side(C, 1), side(B, 7)), link(side(B, 8), side(C, 2))];
    expect(coverageOfLines(as, book(4, [0]))).toEqual(["not-suitable", "linked", "linked", "unlinked"]);
  });

  it("a link of another book's lines only is no coverage of this book", () => {
    expect(coverageOfLines([link(side(B, 1), side(B2, 1))], book(3))).toEqual(["unlinked", "unlinked", "unlinked"]);
  });

  it("a range covers the lines after its start: its own line is linked, the rest are partial", () => {
    expect(coverageOfLines([link(side(C, 1, 3), side(B, 4))], book(6))).toEqual(["unlinked", "linked", "partial", "partial", "unlinked", "unlinked"]);
  });

  it("two links to different places make a line multiple, even when one reaches it through a range", () => {
    const ls = [link(side(C, 1), side(B, 4)), link(side(C, 1), side(B2, 9)), link(side(C, 3, 4), side(B, 6)), link(side(C, 4), side(B, 8))];
    expect(coverageOfLines(ls, book(6))).toEqual(["unlinked", "multiple", "unlinked", "linked", "multiple", "unlinked"]);
  });

  it("the same place twice (a duplicate) is still one place: linked, not multiple", () => {
    expect(coverageOfLines([link(side(C, 1), side(B, 4)), link(side(C, 1), side(B, 4))], book(3))).toEqual(["unlinked", "linked", "unlinked"]);
  });

  it("deleted links cover nothing", () => {
    expect(coverageOfLines([link(side(C, 1), side(B, 4), "deleted")], book(3))).toEqual(["unlinked", "unlinked", "unlinked"]);
  });

  it("lines the caller marks unsuitable (blank, a few letters) are not suitable, and a link on one still shows as linked-or-not by the rule: unsuitable wins", () => {
    expect(coverageOfLines([link(side(C, 2), side(B, 1))], book(4, [], [2, 3]))).toEqual(["unlinked", "unlinked", "not-suitable", "not-suitable"]);
  });

  it("an end outside the book is clipped, not an error", () => {
    expect(coverageOfLines([link(side(C, 3, 99), side(B, 1)), link(side(C, 50), side(B, 2))], book(5))).toEqual(["unlinked", "unlinked", "unlinked", "linked", "partial"]);
  });
});

describe("unlinkedRanges", () => {
  it("consecutive unlinked lines collapse into one range; headings, linked lines and blanks split them", () => {
    const ls = [link(side(C, 3), side(B, 1))];
    expect(unlinkedRanges(ls, book(10, [0, 6], [8]))).toEqual([
      { start: 1, end: 2 },
      { start: 4, end: 5 },
      { start: 7, end: 7 },
      { start: 9, end: 9 },
    ]);
  });

  it("nothing linked: one range per stretch between the headings; everything linked: none", () => {
    expect(unlinkedRanges([], book(7, [0, 3]))).toEqual([{ start: 1, end: 2 }, { start: 4, end: 6 }]);
    const all = [link(side(C, 0, 4), side(B, 1))];
    expect(unlinkedRanges(all, book(5))).toEqual([]);
  });

  it("an empty book has none", () => {
    expect(unlinkedRanges([], book(0))).toEqual([]);
  });

  it("is quick on a large book (100,000 lines, thousands of links)", () => {
    const ls = Array.from({ length: 5000 }, (_, i) => link(side(C, i * 20, i * 20 + 5), side(B, i)));
    const t0 = performance.now();
    const r = unlinkedRanges(ls, book(100_000));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r).toHaveLength(5000);
    expect(r[0]).toEqual({ start: 6, end: 19 });
  });
});

describe("coverageSummary", () => {
  it("counts every bucket, the suitable lines and the unlinked share", () => {
    const ls = [link(side(C, 1), side(B, 1)), link(side(C, 3, 4), side(B, 2))];
    const s = coverageSummary(ls, book(7, [0]));
    expect(s.byBucket).toEqual({ linked: 2, unlinked: 3, partial: 1, multiple: 0, "not-suitable": 1 });
    expect(s).toMatchObject({ total: 7, suitable: 6, unlinked: 3, unlinkedShare: 0.5 });
    expect(s.ranges).toEqual([{ start: 2, end: 2 }, { start: 5, end: 6 }]);
  });
  it("no suitable line: a share of 0, not NaN", () => {
    expect(coverageSummary([], book(2, [0, 1])).unlinkedShare).toBe(0);
  });
});
