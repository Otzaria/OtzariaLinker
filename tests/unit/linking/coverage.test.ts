import { describe, expect, it } from "vitest";
import type { BookRef, Link, LinkSide } from "../../../src/core/links/model";
import type { Suggestion } from "../../../src/linking/automatic";
import { candidateLines, coverageCounts, coverageOfLines, coverageSummary, doubtfulLines, MAX_BOOK_LINES, unlinkedRanges, type CoverageBook } from "../../../src/linking/coverage";
import type { QaIssue } from "../../../src/linking/qa";

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
    expect(s.byBucket).toEqual({ linked: 2, unlinked: 3, partial: 1, multiple: 0, "not-suitable": 1, candidate: 0, doubtful: 0 });
    expect(s).toMatchObject({ total: 7, suitable: 6, unlinked: 3, unlinkedShare: 0.5 });
    expect(s.ranges).toEqual([{ start: 2, end: 2 }, { start: 5, end: 6 }]);
  });
  it("no suitable line: a share of 0, not NaN", () => {
    expect(coverageSummary([], book(2, [0, 1])).unlinkedShare).toBe(0);
  });
});

/* 2.15 — two more buckets: a candidate found but not approved, and a link the QA doubts */
describe("coverageOfLines — candidate and doubtful", () => {
  const withSets = (extra: Partial<CoverageBook>, n = 6, headings: number[] = []) => ({ ...book(n, headings), ...extra });

  it("an unlinked line that a pending suggestion points at is 'candidate' (found, not approved), not 'unlinked'", () => {
    expect(coverageOfLines([link(side(C, 1), side(B, 1))], withSets({ candidates: new Set([1, 2, 3]) }, 5))).toEqual(["unlinked", "linked", "candidate", "candidate", "unlinked"]);
  });

  it("a covered line the QA flags is 'doubtful', whatever it was (linked, partial, multiple)", () => {
    const ls = [link(side(C, 0, 1), side(B, 5)), link(side(C, 3), side(B, 6)), link(side(C, 3), side(B2, 7))];
    expect(coverageOfLines(ls, withSets({ doubtful: new Set([1, 3]) }, 5))).toEqual(["linked", "doubtful", "unlinked", "doubtful", "unlinked"]);
  });

  it("not-suitable wins over both; unlinkedRanges still means only 'unlinked' (a candidate line is already found)", () => {
    const b = withSets({ candidates: new Set([2]), doubtful: new Set([0]) }, 4, [0]);
    expect(coverageOfLines([], b)).toEqual(["not-suitable", "unlinked", "candidate", "unlinked"]);
    expect(unlinkedRanges([], b)).toEqual([{ start: 1, end: 1 }, { start: 3, end: 3 }]);
  });

  it("the summary counts them; the unlinked share counts only the lines nothing found", () => {
    const s = coverageSummary([link(side(C, 0), side(B, 1))], withSets({ candidates: new Set([1]), doubtful: new Set([0]) }, 3));
    expect(s.byBucket).toEqual({ linked: 0, unlinked: 1, partial: 0, multiple: 0, "not-suitable": 0, candidate: 1, doubtful: 1 });
    expect(s.unlinkedShare).toBeCloseTo(1 / 3);
  });
});

describe("candidateLines and doubtfulLines — the lines of ONE book from suggestions and from the QA", () => {
  const sug = (id: string, source: LinkSide, target: LinkSide, confidence: Suggestion["confidence"] = "high") => ({ id, source, target, confidence }) as Suggestion;
  it("candidates: both ends that lie in the book, ranges whole, pending only, no 'none'", () => {
    const list = [sug("a", side(C, 2), side(B, 9)), sug("b", side(B, 1), side(C, 4, 5)), sug("c", side(C, 7), side(B, 1)), sug("d", side(C, 8), side(B, 1), "none"), sug("e", side(B, 3), side(B2, 3))];
    const lines = candidateLines(list, (id) => id !== "c", (r) => r.key === "c");
    expect([...lines].sort((x, y) => x - y)).toEqual([2, 4, 5]);
  });
  it("doubtful: links of the QA's errors and warnings, but not its administrative notes (already in the database, a library file, unverified)", () => {
    const l1 = link(side(C, 1), side(B, 1));
    const l2 = link(side(C, 3, 4), side(B, 2));
    const l3 = link(side(C, 6), side(B, 3));
    const issues = [
      { link: l1, problem: { severity: "warning" }, category: "anchor" },
      { link: l2, problem: { severity: "error" }, category: "heading" },
      { link: l3, problem: { severity: "warning" }, category: "in-db" },
      { link: l3, problem: { severity: "info" }, category: "anchor" },
    ] as unknown as QaIssue[];
    expect([...doubtfulLines(issues, (r) => r.key === "c")].sort((x, y) => x - y)).toEqual([1, 3, 4]);
  });
});

describe("coverageCounts — the table row, no ranges", () => {
  it("is the summary without the ranges, for many books", () => {
    const ls = [link(side(C, 1), side(B, 1))];
    const c = coverageCounts(ls, book(4, [0]));
    expect(c).toEqual({ total: 4, byBucket: coverageSummary(ls, book(4, [0])).byBucket, suitable: 3, unlinked: 2, unlinkedShare: 2 / 3 });
    expect("ranges" in c).toBe(false);
  });
});

describe("hostile sizes: a range end or a line count from a file must not become a loop or an allocation (QA round 2, A and B)", () => {
  it("candidateLines and doubtfulLines clamp a range end of 2^53-1 to the book's lines, and finish at once", () => {
    const huge = Number.MAX_SAFE_INTEGER;
    const t0 = Date.now();
    const sug = { id: "a", source: side(C, 2, huge), target: side(B, 1), confidence: "high" } as Suggestion;
    expect([...candidateLines([sug], () => true, (r) => r.key === "c", 6)]).toEqual([2, 3, 4, 5]);
    const issues = [{ link: link(side(C, 1, huge), side(B, 1)), problem: { severity: "error" }, category: "heading" }] as unknown as QaIssue[];
    expect([...doubtfulLines(issues, (r) => r.key === "c", 4)]).toEqual([1, 2, 3]);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it("without a line count the clamp is the shared cap, so the set can never outgrow it", () => {
    const sug = { id: "a", source: side(C, 0, Number.MAX_SAFE_INTEGER), target: side(B, 1), confidence: "high" } as Suggestion;
    expect(candidateLines([sug], () => true, (r) => r.key === "c").size).toBe(MAX_BOOK_LINES);
  });
  it("the cap is 5 million lines", () => {
    expect(MAX_BOOK_LINES).toBe(5_000_000);
  });
  it("a book just over the cap gets a clear 'tooLarge' result with no buckets, not an allocation", () => {
    const s = coverageSummary([link(side(C, 1), side(B, 1))], book(6_000_000));
    expect(s.tooLarge).toBe(true);
    expect(s.total).toBe(6_000_000);
    expect(s.ranges).toEqual([]);
    expect(Object.values(s.byBucket).every((n) => n === 0)).toBe(true);
    expect(coverageCounts([], book(6_000_000)).tooLarge).toBe(true);
    expect(unlinkedRanges([], book(6_000_000))).toEqual([]);
    expect(() => coverageOfLines([], book(6_000_000))).toThrow(RangeError);
  });
  it("a database that reports a billion lines is answered at once", () => {
    const t0 = Date.now();
    expect(coverageSummary([], book(1_000_000_000)).tooLarge).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it("a book at the cap is still counted exactly", () => {
    const s = coverageSummary([link(side(C, 4_999_999), side(B, 1))], book(MAX_BOOK_LINES));
    expect(s.tooLarge).toBeUndefined();
    expect(s.byBucket.linked).toBe(1);
    expect(s.unlinked).toBe(MAX_BOOK_LINES - 1);
  });
});
