import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CoverageEndsBuilder, coverageEndsOf } from "../../../src/core/links/coverage-ends";
import type { BookRef, Link, LinkSide } from "../../../src/core/links/model";
import { contentUnits, coverageCounts, coverageOfLines, coverageSummary, type CoverageBook } from "../../../src/linking/coverage";

/*
 * #42 C7, C8: the database's links of a book reach the coverage rules as compact ends (core/links/coverage-ends.ts) instead of
 * Link objects. The rules must count them EXACTLY as they count the same links given as Links: checked on generated books and
 * links — ranges, links inside the book, links to the same place spelled by another key, deleted links, several units per line.
 */
const C: BookRef = { key: "c", title: "פירוש", origin: "otzaria" };
const C2: BookRef = { key: "unresolved:פירוש", title: "פירוש", origin: "unknown" };
const B: BookRef = { key: "b", title: "בסיס", origin: "otzaria" };
const B2: BookRef = { key: "b2", title: "בסיס שני", origin: "otzaria" };
// a project link may name the same base book by another key: one place for the rules (they compare titles)
const B_FILE: BookRef = { key: "unresolved:בסיס", title: "בסיס", origin: "unknown" };
const owns = (r: BookRef) => r.key === "c";

const LINES = 30;
const sideArb = fc.record({
  book: fc.constantFrom(C, C, C, C2, B, B2, B_FILE),
  line: fc.integer({ min: -1, max: LINES + 2 }),
  end: fc.option(fc.integer({ min: -1, max: LINES + 5 }), { nil: undefined }),
}).map(({ book, line, end }): LinkSide => ({ book, line, ...(end !== undefined && { end }) }));
let n = 0;
const linkArb = fc.record({ source: sideArb, target: sideArb, deleted: fc.integer({ min: 0, max: 9 }).map((x) => x === 0) }).map(
  ({ source, target, deleted }): Link => ({ id: `l${n++}`, status: deleted ? "deleted" : "existing", provenance: "db", source, target, declaredType: "commentary", heRef2: "" }),
);
const bookArb = fc.record({
  headings: fc.uniqueArray(fc.integer({ min: 0, max: LINES - 1 }), { maxLength: 4 }),
  units: fc.array(fc.tuple(fc.integer({ min: 0, max: LINES - 1 }), fc.integer({ min: 2, max: 4 })), { maxLength: 6 }),
});

describe("compact ends are counted exactly as the same links (#42 C7, C8)", () => {
  it("coverageOfLines and coverageSummary: project links as Links, database links as ends == all as Links", () => {
    fc.assert(
      fc.property(fc.array(linkArb, { maxLength: 25 }), fc.array(linkArb, { maxLength: 40 }), bookArb, (project, db, b) => {
        const book: CoverageBook = { owns, lineCount: LINES, headings: new Set(b.headings), units: new Map(b.units) };
        const withEnds: CoverageBook = { ...book, ends: coverageEndsOf(db, owns) };
        expect(coverageOfLines(project, withEnds)).toEqual(coverageOfLines([...project, ...db], book));
        expect(coverageSummary(project, withEnds)).toEqual(coverageSummary([...project, ...db], book));
      }),
      { numRuns: 3000 },
    );
  });

  it("contentUnits: the same units per line", () => {
    fc.assert(
      fc.property(fc.array(linkArb, { maxLength: 25 }), fc.array(linkArb, { maxLength: 40 }), (project, db) => {
        expect(contentUnits(project, [], () => true, owns, LINES, coverageEndsOf(db, owns))).toEqual(contentUnits([...project, ...db], [], () => true, owns, LINES));
      }),
      { numRuns: 2000 },
    );
  });

  it("a book the size of בראשית (235,000 ends over 1,584 lines, to 300 books) is counted on the page in well under 2 s", () => {
    // generous on purpose (35-100 ms on the development machine): it catches a return to per-place objects and keys, not noise
    const b = new CoverageEndsBuilder();
    for (let i = 0; i < 235_000; i++) b.add(i % 1584, i % 1584, `book ${i % 300}`, (i * 7) % 5000, (i * 7) % 5000);
    const t0 = performance.now();
    const c = coverageCounts([], { owns, lineCount: 1584, headings: new Set(), ends: b.build() });
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(c.byBucket.multiple).toBe(1584);
  }, 30_000);

  it("the ends keep one entry per end in the book, the links read, and one place per (title, lines)", () => {
    const ls: Link[] = [
      { id: "a", status: "existing", provenance: "db", source: { book: C, line: 1 }, target: { book: B, line: 4 }, declaredType: "", heRef2: "" },
      { id: "b", status: "existing", provenance: "db", source: { book: B, line: 4 }, target: { book: C, line: 2, end: 5 }, declaredType: "", heRef2: "" },
      { id: "c", status: "existing", provenance: "db", source: { book: C, line: 3 }, target: { book: C, line: 7 }, declaredType: "", heRef2: "" },
    ];
    const e = coverageEndsOf(ls, owns);
    expect(e.links).toBe(3);
    expect([...e.line]).toEqual([1, 2, 3, 7]);
    expect([...e.end]).toEqual([1, 5, 3, 7]);
    // "a" and "b" both point at בסיס line 4: one place
    expect(e.place[0]).toBe(e.place[1]);
    expect(e.placeTitle.length).toBe(3);
  });
});
