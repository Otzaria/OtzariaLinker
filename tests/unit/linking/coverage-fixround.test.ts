import { describe, expect, it } from "vitest";
import type { BookRef, Link, LinkSide } from "../../../src/core/links/model";
import type { Suggestion } from "../../../src/linking/automatic";
import { contentUnits, coverageCounts, coverageOfLines, coverageSummary, linksReadingText, type CoverageBook } from "../../../src/linking/coverage";

/*
 * Fix round before the merge of PR 2.
 * Claim 4: what "partial" and "multiple" mean (docs/AUTOMATION_ENGINE.md §5.8).
 *   multiple  a line linked to at least TWO SEMANTICALLY DIFFERENT places. One place is: the same lines however many links say so
 *             (a doubled bidirectional link, two anchors of one relation, two link types); a coarse span and an exact line inside it
 *             (the library's whole-siman link and a line of that siman). Different places: another book, or lines that do not overlap.
 *   partial   a line is partial when it is NOT fully linked although some link touches it: it holds several content units
 *             (CoverageBook.units: quotations, notes, citations) of which fewer have a link of their own, or a range link reaches
 *             it from an earlier line. A line with ONE unit and one link of its own is "linked", never partial.
 * Claim 3: the reading of the database's links is part of the result.
 */
const C: BookRef = { key: "c", title: "פירוש", origin: "otzaria" };
const B: BookRef = { key: "b", title: "בסיס", origin: "otzaria" };
const B2: BookRef = { key: "b2", title: "בסיס שני", origin: "otzaria" };
const side = (book: BookRef, line: number, end?: number): LinkSide => ({ book, line, ...(end !== undefined && { end }) });
let n = 0;
const link = (source: LinkSide, target: LinkSide, status: Link["status"] = "new"): Link => ({ id: `l${n++}`, status, provenance: "user", source, target, declaredType: "commentary", heRef2: "" });
const book = (lineCount: number, headings: number[] = [], unsuitable: number[] = []): CoverageBook => ({ owns: (r) => r.key === "c", lineCount, headings: new Set(headings), unsuitable: new Set(unsuitable) });

describe("coverageOfLines — multiple means different places", () => {
  it("a bidirectional pair written twice (A→B and B→A) is one place", () => {
    expect(coverageOfLines([link(side(C, 1), side(B, 4)), link(side(B, 4), side(C, 1))], book(3))).toEqual(["unlinked", "linked", "unlinked"]);
  });

  it("two anchors of one relation (same lines, different words) are one place", () => {
    const a = { ...link(side(C, 1), side(B, 4)), anchor: { rawStart: 0, rawEnd: 3 } };
    const b = { ...link(side(C, 1), side(B, 4)), anchor: { rawStart: 10, rawEnd: 14 } };
    expect(coverageOfLines([a, b], book(3))).toEqual(["unlinked", "linked", "unlinked"]);
  });

  it("the same place under two link types is one place", () => {
    const a = link(side(C, 1), side(B, 4));
    const b = { ...link(side(C, 1), side(B, 4)), declaredType: "reference" };
    expect(coverageOfLines([a, b], book(3))).toEqual(["unlinked", "linked", "unlinked"]);
  });

  it("a coarse link to a whole span and an exact line inside it are one place, not two targets", () => {
    const coarse = link(side(C, 1), side(B, 10, 40));
    const exact = link(side(C, 1), side(B, 25));
    expect(coverageOfLines([coarse, exact], book(3))).toEqual(["unlinked", "linked", "unlinked"]);
    expect(coverageOfLines([coarse, link(side(C, 1), side(B, 50))], book(3))[1]).toBe("multiple");
  });

  it("different books, or lines that do not overlap, are different places", () => {
    expect(coverageOfLines([link(side(C, 1), side(B, 4)), link(side(C, 1), side(B2, 4))], book(3))[1]).toBe("multiple");
    expect(coverageOfLines([link(side(C, 1), side(B, 4)), link(side(C, 1), side(B, 5))], book(3))[1]).toBe("multiple");
  });

  it("overlap is transitive: spans that chain together are one place", () => {
    const ls = [link(side(C, 1), side(B, 1, 5)), link(side(C, 1), side(B, 5, 9)), link(side(C, 1), side(B, 9, 12))];
    expect(coverageOfLines(ls, book(3))[1]).toBe("linked");
  });
});

describe("coverageOfLines — partial means a line not fully linked", () => {
  const withUnits = (units: [number, number][], n = 4): CoverageBook => ({ ...book(n), units: new Map(units) });

  it("a line with a single link and a single unit is linked, never partial", () => {
    expect(coverageOfLines([link(side(C, 1), side(B, 4))], withUnits([[1, 1]]))[1]).toBe("linked");
    expect(coverageOfLines([link(side(C, 1), side(B, 4))], book(4))[1]).toBe("linked");
  });

  it("a line with three units of which one has a link is partial", () => {
    expect(coverageOfLines([link(side(C, 1), side(B, 4))], withUnits([[1, 3]]))[1]).toBe("partial");
  });

  it("when every unit has a link of its own the line is linked; two units in two places is multiple, not partial", () => {
    const a = { ...link(side(C, 1), side(B, 4)), anchor: { rawStart: 0, rawEnd: 3 } };
    const b = { ...link(side(C, 1), side(B, 6)), anchor: { rawStart: 10, rawEnd: 14 } };
    expect(coverageOfLines([a, b], withUnits([[1, 2]]))[1]).toBe("multiple");
    const same = [a, { ...link(side(C, 1), side(B, 4)), anchor: { rawStart: 10, rawEnd: 14 } }];
    expect(coverageOfLines(same, withUnits([[1, 2]]))[1]).toBe("linked");
  });

  it("an unlinked line with several units is unlinked, not partial: nothing touches it", () => {
    expect(coverageOfLines([], withUnits([[1, 3]]))[1]).toBe("unlinked");
  });

  it("a range link reaches the lines after its start as partial, as before", () => {
    expect(coverageOfLines([link(side(C, 1, 2), side(B, 4))], book(4))).toEqual(["unlinked", "linked", "partial", "unlinked"]);
  });

  it("contentUnits counts the distinct units of links and pending suggestions on a line (an anchor, else the place)", () => {
    const a = { ...link(side(C, 1), side(B, 4)), anchor: { rawStart: 0, rawEnd: 3 } };
    const sug = (id: string, anchorAt: number, target: LinkSide) => ({ id, source: side(C, 1), target, anchor: { rawStart: anchorAt, rawEnd: anchorAt + 2 }, confidence: "high" }) as unknown as Suggestion;
    const units = contentUnits([a], [sug("s1", 0, side(B, 4)), sug("s2", 10, side(B, 6)), sug("s3", 20, side(B, 9))], () => true, (r) => r.key === "c", 4);
    // s1 is the link already there; s2 and s3 are two more units of line 1
    expect(units.get(1)).toBe(3);
    // a rejected one does not count, and one unit is not stored at all
    expect(contentUnits([a], [sug("s2", 10, side(B, 6))], () => false, (r) => r.key === "c", 4).get(1)).toBeUndefined();
  });
});

describe("the reading of the database's links", () => {
  it("the pure counts do not claim anything about the database's links unless told", () => {
    expect(coverageSummary([], book(3)).links).toBeUndefined();
    expect(coverageSummary([], book(3), { state: "none" }).links).toEqual({ state: "none" });
    expect(coverageCounts([], book(3), { state: "failed", message: "x" }).links).toEqual({ state: "failed", message: "x" });
  });

  it("each state has its own Hebrew sentence, and a failed read never reads like 'no links'", () => {
    const all = [linksReadingText({ state: "none" }), linksReadingText({ state: "counted", count: 3 }), linksReadingText({ state: "unknown", why: "not-requested" }), linksReadingText({ state: "failed", message: "boom" })];
    expect(new Set(all).size).toBe(4);
    expect(linksReadingText({ state: "failed", message: "boom" })).toContain("boom");
    expect(linksReadingText({ state: "failed", message: "boom" })).toContain("לא נקראו");
  });
});
