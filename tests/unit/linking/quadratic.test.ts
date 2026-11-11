import { describe, expect, it } from "vitest";
import { AliasIndex } from "../../../src/linking/automatic/citations/aliases";
import { citationTokens } from "../../../src/linking/automatic/citations/text";
import { planMaxLink } from "../../../src/linking/plan";

/*
 * Security review A8: lists built with `m.set(k, [...(m.get(k) ?? []), x])` and scans over the whole
 * line per character were quadratic — 12 s (plan, on the UI thread), 24.6 s (aliases) at 40,000
 * items. The bounds below are loose (a slow CI machine) but far under the quadratic times.
 */
const time = (f: () => unknown): number => {
  const t = performance.now();
  f();
  return performance.now() - t;
};

describe("linear on hostile sizes", () => {
  it("max-link plan: a base with 40,000 commentaries", () => {
    const base = { key: "b", title: "בראשית", origin: "personal" as const };
    const lib = [base, ...Array.from({ length: 40_000 }, (_, i) => ({ key: `c${i}`, title: `פירוש${i} על בראשית`, origin: "personal" as const, bases: ["b"] }))];
    expect(time(() => planMaxLink({ selected: ["b"], library: lib }))).toBeLessThan(4_000);
  }, 60_000);

  it("citations alias index: 40,000 books with one title", () => {
    expect(time(() => AliasIndex.build(Array.from({ length: 40_000 }, (_, i) => ({ book: { key: `k${i}`, title: "ספר", origin: "personal" as const } }))))).toBeLessThan(4_000);
  }, 60_000);

  it("citation tokens of a line of 200,000 '&'", () => {
    expect(time(() => citationTokens("&".repeat(200_000)))).toBeLessThan(2_000);
  }, 60_000);
});
