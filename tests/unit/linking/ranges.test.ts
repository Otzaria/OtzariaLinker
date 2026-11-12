import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BookRef, Link, LinkSide } from "../../../src/core/links/model";
import { applyRangeEdit, fillRanges, rangeMarkers, suggestEnd, trimBefore, type RangeBook } from "../../../src/linking/ranges";

const A: BookRef = { key: "a", title: "ספר", origin: "personal" };
const B: BookRef = { key: "b", title: "הערות", origin: "personal" };
let seq = 0;
const link = (src: LinkSide, tgt: LinkSide, extra: Partial<Link> = {}): Link => ({
  id: `l${++seq}`, source: src, target: tgt, declaredType: "commentary", heRef2: "", status: "new", provenance: "user", ...extra,
});
const at = (book: BookRef, line: number, end?: number): LinkSide => (end === undefined ? { book, line } : { book, line, end });
const bookOf = (ref: BookRef, lineCount: number, headings: number[] = []): RangeBook => ({ owns: (r) => r.key === ref.key, lineCount, headings: new Set(headings) });

describe("suggestEnd (v3 F-054/F-055)", () => {
  const book = bookOf(A, 20, [10]);
  const links = [link(at(A, 2), at(B, 0)), link(at(A, 6), at(B, 1))];
  const markers = rangeMarkers(links, book, "source");

  it("markers are the starts of this side's links plus the headings, sorted and unique", () => {
    expect(markers).toEqual([2, 6, 10]);
    expect(rangeMarkers(links, book, "source", "links")).toEqual([2, 6]);
    expect(rangeMarkers(links, book, "source", "headings")).toEqual([10]);
    expect(rangeMarkers(links, book, "source", "book")).toEqual([]);
    expect(rangeMarkers(links, book, "target")).toEqual([10]); // B's lines are not A's
  });

  it("one line before the next marker; the last range runs to the end of the book", () => {
    expect(suggestEnd(2, markers, book)).toBe(5);
    expect(suggestEnd(3, markers, book)).toBe(5);
    expect(suggestEnd(11, markers, book)).toBe(19);
  });

  it("a next marker right after the start gives no range", () => {
    expect(suggestEnd(5, markers, book)).toBe(5);
  });

  it("an end on a heading line steps back (Otzaria drops a range that ends on a heading)", () => {
    const b = bookOf(A, 10, [8, 9]);
    expect(suggestEnd(3, [], b)).toBe(7);
  });

  it("an excluded link (the one being edited) is not its own marker", () => {
    expect(rangeMarkers(links, book, "source", "links", links[0]!.id)).toEqual([6]);
  });

  it("deleted links are not markers", () => {
    expect(rangeMarkers([link(at(A, 4), at(B, 0), { status: "deleted" })], book, "source", "links")).toEqual([]);
  });
});

describe("trimBefore (v3 F-064)", () => {
  it("only a range of this book and side that starts before the new line and reaches it is cut", () => {
    const covering = link(at(A, 2, 9), at(B, 0));
    const after = link(at(A, 7, 9), at(B, 1));
    const short = link(at(A, 1, 3), at(B, 2));
    const other = link(at(B, 2, 9), at(A, 0));
    const edits = trimBefore([covering, after, short, other], bookOf(A, 20), "source", 5);
    expect(edits.map((e) => [e.link.id, e.before, e.after])).toEqual([[covering.id, 9, 4]]);
  });

  it("a range cut down to its own line becomes a single-line link", () => {
    const l = link(at(A, 4, 9), at(B, 0));
    expect(trimBefore([l], bookOf(A, 20), "source", 5).map((e) => e.after)).toEqual([undefined]);
  });

  it("database links are never changed", () => {
    expect(trimBefore([link(at(A, 2, 9), at(B, 0), { provenance: "db" })], bookOf(A, 20), "source", 5)).toEqual([]);
  });
});

describe("fillRanges (v3 F-084/F-105)", () => {
  const links = () => [link(at(A, 1, 1 + 1), at(B, 0)), link(at(A, 4), at(B, 1)), link(at(A, 8, 9), at(B, 2))];

  it("only ranged links by default: each runs to one line before the next start, the last to the end", () => {
    const r = fillRanges(links(), bookOf(A, 12), "source");
    expect(r.edits.map((e) => [e.link.source.line, e.before, e.after])).toEqual([[1, 2, 3], [8, 9, 11]]);
  });

  it("onlyRanged false turns single-line links into ranges too", () => {
    const r = fillRanges(links(), bookOf(A, 12), "source", { onlyRanged: false });
    expect(r.edits.map((e) => [e.link.source.line, e.after])).toEqual([[1, 3], [4, 7], [8, 11]]);
  });

  it("an end on a heading steps back; no change is reported when nothing changes", () => {
    const r = fillRanges(links(), bookOf(A, 12, [7, 11]), "source", { onlyRanged: false });
    expect(r.edits.map((e) => [e.link.source.line, e.after])).toEqual([[1, 3], [4, 6], [8, 10]]);
    const done = r.edits.map((e) => applyRangeEdit(e.link, e.side, e.after));
    expect(fillRanges(done, bookOf(A, 12, [7, 11]), "source", { onlyRanged: false }).edits).toEqual([]);
  });

  it("a book with no known length (a shadow book from a links file) is never touched", () => {
    expect(fillRanges(links(), bookOf(A, 0), "source")).toEqual({ edits: [], skippedNoText: true });
  });

  it("works on the target side the same way", () => {
    const ls = [link(at(B, 0), at(A, 2, 3)), link(at(B, 1), at(A, 6))];
    expect(fillRanges(ls, bookOf(A, 10), "target").edits.map((e) => [e.link.target.line, e.after])).toEqual([[2, 5]]);
  });

  it("property: after filling, no two ranges of the side overlap and none ends on a heading or past the book", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 59 }), { minLength: 1, maxLength: 20 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 59 }), { maxLength: 8 }),
        (starts, headings) => {
          const hs = new Set(headings.filter((h) => !starts.includes(h)));
          const book: RangeBook = { owns: (r) => r.key === "a", lineCount: 60, headings: hs };
          const ls = starts.map((s, i) => link(at(A, s), at(B, i)));
          const filled = fillRanges(ls, book, "source", { onlyRanged: false }).edits;
          const byId = new Map(ls.map((l) => [l.id, l]));
          for (const e of filled) byId.set(e.link.id, applyRangeEdit(e.link, e.side, e.after));
          const spans = [...byId.values()].map((l) => [l.source.line, l.source.end ?? l.source.line] as const).sort((a, b) => a[0] - b[0]);
          for (let i = 0; i < spans.length; i++) {
            const [s, e] = spans[i]!;
            expect(e).toBeLessThan(60);
            if (e > s) expect(hs.has(e)).toBe(false);
            if (i + 1 < spans.length) expect(e).toBeLessThan(spans[i + 1]![0]);
          }
        },
      ),
    );
  });
});

describe("applyRangeEdit", () => {
  it("sets or removes the end and marks an imported link as edited", () => {
    const l = link(at(A, 3), at(B, 0), { status: "existing" });
    const ranged = applyRangeEdit(l, "source", 7);
    expect(ranged.source).toEqual({ book: A, line: 3, end: 7 });
    expect(ranged.status).toBe("edited");
    expect(applyRangeEdit(ranged, "source", undefined).source).toEqual({ book: A, line: 3 });
    expect(applyRangeEdit(l, "source", 3).source).toEqual({ book: A, line: 3 });
  });
});
