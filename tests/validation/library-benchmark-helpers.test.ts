import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../src/core/links/model";
import type { Suggestion } from "../../src/linking/automatic/types";
import { allocate, decodeIds, encodeIds, estimate, indexDbLinks, ownerOf, scoreBook, stratify } from "./library-benchmark";

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
