import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../src/core/links/model";
import type { Suggestion } from "../../src/linking/automatic/types";
import { allocate, decodeIds, encodeIds, estimate, indexDbLinks, isSpanned, ownerOf, scoreBook, spanBucket, spanEnds, spanRecords, stratify } from "./library-benchmark";

/* The pure parts of the library benchmark (no database needed). */

const book = (id: number): BookRef => ({ key: `s1:${id}`, title: `b${id}`, origin: "sefaria" });
const link = (id: number, type: string, s: [number, number, number?], t: [number, number, number?], anchor?: [number, number]): Link => ({
  id: `s1:link:${id}`,
  status: "existing",
  provenance: "db",
  source: { book: book(s[0]), line: s[1], ...(s[2] !== undefined && { end: s[2] }) },
  target: { book: book(t[0]), line: t[1], ...(t[2] !== undefined && { end: t[2] }) },
  declaredType: type,
  heRef2: "",
  ...(anchor && { dbAnchors: [{ side: 0 as const, charStart: anchor[0], charEnd: anchor[1] }] }),
});
const sug = (id: string, s: [number, number], t: [number, number, number?], confidence: Suggestion["confidence"] = "certain"): Suggestion => ({
  id,
  engine: "citations",
  source: { book: book(s[0]), line: s[1] },
  target: { book: book(t[0]), line: t[1], ...(t[2] !== undefined && { end: t[2] }) },
  declaredType: "reference",
  heRef2: "",
  score: 1,
  confidence,
  reasons: [],
  rules: [],
  alternatives: [],
  warnings: [],
});

describe("library benchmark helpers", () => {
  const related = (dep: number, base: number) => dep === 2 && base === 1;

  it("owners: LINKER by its source, a related pair by the dependant, the rest by the pair", () => {
    expect(ownerOf("LINKER", 5, 1, related)).toBe("D:5");
    expect(ownerOf("COMMENTARY", 1, 2, related)).toBe("D:2");
    expect(ownerOf("OTHER", 9, 3, related)).toBe("U:3-9");
  });

  it("scores a book: intersecting = correct, other lines of the same book = wrong, else new", () => {
    const own = (type: string, s: number, t: number) => ownerOf(type, s, t, related);
    const db = indexDbLinks("s1:2", [link(10, "commentary", [1, 4], [2, 0]), link(11, "other", [2, 1], [3, 7, 9])], own);
    const r = scoreBook(
      "s1:2",
      [
        { s: { ...sug("a", [2, 0], [1, 4]), engine: "headings" }, engines: ["headings"] },
        { s: sug("b", [2, 1], [3, 8]), engines: ["citations"] },
        { s: { ...sug("c", [2, 0], [1, 6]), engine: "headings" }, engines: ["headings"] },
        { s: sug("d", [2, 5], [3, 1]), engines: ["citations"] },
      ],
      db,
      () => undefined,
    );
    expect(r.scored.map((x) => x.verdict)).toEqual(["correct", "correct", "wrong", "unconfirmed"]);
    expect([...r.matched.get("COMMENTARY|D:2")!]).toEqual([10]);
    expect([...r.matched.get("OTHER|U:2-3")!]).toEqual([11]);
    expect(r.scored[0]!.pairType).toBe("COMMENTARY");
  });

  it("a citation is wrong only against a stored citation of the same words", () => {
    const own = (type: string, s: number, t: number) => ownerOf(type, s, t, related);
    const db = indexDbLinks("s1:5", [link(20, "linker", [5, 0], [1, 9], [10, 14])], own);
    const text = "0123456789abcdefghijklmnopqrstuvwxyz";
    const r = scoreBook("s1:5", [{ s: sug("x@0-4>s1:1", [5, 0], [1, 3]), engines: ["citations"] }, { s: sug("y@11-13>s1:1", [5, 0], [1, 2]), engines: ["citations"] }], db, () => text);
    expect(r.scored.map((x) => x.verdict)).toEqual(["unconfirmed", "wrong"]);
    // a merged suggestion ("mx:…") carries the words in its raw member's id
    const m = scoreBook("s1:5", [{ s: sug("mx:5#0>1#3", [5, 0], [1, 3]), engines: ["citations"], spanId: "x@0-4>s1:1" }], db, () => text);
    expect(m.scored.map((x) => x.verdict)).toEqual(["unconfirmed"]);
  });

  it("a range collapsed on a Sefaria side: its citedSpan counts by default, only the written line with spans 'citations'", () => {
    const own = (type: string, s: number, t: number) => ownerOf(type, s, t, related);
    const db = indexDbLinks("s1:2", [link(30, "commentary", [1, 7], [2, 0])], own);
    const collapsed = { s: { ...sug("h", [2, 0], [1, 4]), engine: "headings" as const, citedSpan: { line: 4, end: 9 } }, engines: ["headings" as const] };
    expect(scoreBook("s1:2", [collapsed], db, () => undefined).scored[0]!.verdict).toBe("correct");
    expect(scoreBook("s1:2", [collapsed], db, () => undefined, "citations").scored[0]!.verdict).toBe("wrong");
    // a citation's cited unit counts either way
    const cited = { s: { ...sug("c", [2, 0], [1, 4]), citedSpan: { line: 4, end: 9 } }, engines: ["citations" as const] };
    expect(scoreBook("s1:2", [cited], db, () => undefined, "citations").scored[0]!.verdict).toBe("correct");
  });

  it("a cut Sefaria-side span written by each policy (§0.8), and the end the database links", () => {
    const own = (type: string, s: number, t: number) => ownerOf(type, s, t, related);
    const cut = { ...sug("h", [2, 0], [1, 4]), engine: "dibur-hamatchil" as const, citedSpan: { line: 4, end: 7 } };
    expect(isSpanned(cut, ["dibur-hamatchil"])).toBe(true);
    expect(isSpanned(cut, ["citations"])).toBe(false);
    expect(spanRecords(cut, "first").map((s) => [s.target.line, s.target.end, s.citedSpan])).toEqual([[4, undefined, undefined]]);
    expect(spanRecords(cut, "last").map((s) => s.target.line)).toEqual([7]);
    expect(spanRecords(cut, "ends").map((s) => s.target.line)).toEqual([4, 7]);
    expect(spanRecords(cut, "all").map((s) => s.target.line)).toEqual([4, 5, 6, 7]);
    // "all" skips a line that cannot be written (a heading, no ref_2); none writable → the first line, as today
    expect(spanRecords(cut, "all", (l) => l !== 5).map((s) => s.target.line)).toEqual([4, 6, 7]);
    expect(spanRecords(cut, "all", () => false).map((s) => s.target.line)).toEqual([4]);
    expect(spanRecords(cut, "firstRef", (l) => l > 5).map((s) => s.target.line)).toEqual([6]);
    expect([2, 3, 6, 21].map(spanBucket)).toEqual(["2", "3-5", "6-20", ">20"]);
    // the database links the last line of two spans, the first of one: "last"; a link to both ends does not vote
    const db = indexDbLinks("s1:2", [link(40, "commentary", [1, 7], [2, 0]), link(41, "commentary", [1, 12], [2, 1]), link(42, "commentary", [1, 20], [2, 2]), link(43, "commentary", [1, 30, 33], [2, 3])], own);
    const spans = [cut, { ...cut, source: { ...cut.source, line: 1 }, citedSpan: { line: 10, end: 12 } }, { ...cut, source: { ...cut.source, line: 2 }, citedSpan: { line: 20, end: 25 } }, { ...cut, source: { ...cut.source, line: 3 }, citedSpan: { line: 30, end: 33 } }];
    expect(spanEnds("s1:2", spans, db).get(1)).toEqual({ end: "last", first: 1, last: 2 });
  });

  it("ids survive the compact encoding", () => {
    const ids = [5, 1_000_000, 3, 77, 77];
    expect(decodeIds(encodeIds(ids))).toEqual([3, 5, 77, 1_000_000]);
    expect(decodeIds("")).toEqual([]);
  });

  it("stratified sample: pooled small strata, prefix-stable order, proportional allocation", () => {
    const units = Array.from({ length: 40 }, (_, i) => ({ id: `D:${i}`, stratum: i < 30 ? "a" : i < 39 ? "b" : "c", links: 10 }));
    const st = stratify(units, "seed", 0.05);
    expect(st.map((s) => s.name)).toEqual(["a", "b", "(שאר)"]);
    const a = allocate(st, 10);
    expect([...a.values()].reduce((x, y) => x + y, 0)).toBe(10);
    expect(a.get("a")).toBeGreaterThan(a.get("b")!);
    expect(stratify(units, "seed", 0.05)[0]!.units.map((u) => u.id)).toEqual(st[0]!.units.map((u) => u.id));
  });

  it("estimate: a fully observed population has no error", () => {
    const e = estimate([{ links: 30, population: 2, obs: [{ scope: 10, matched: 5 }, { scope: 20, matched: 20 }] }]);
    expect(e.recall).toBeCloseTo(25 / 30);
    expect(e.ci).toBe(0);
  });
});
