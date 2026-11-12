import { describe, expect, it } from "vitest";
import { AliasIndex } from "../../../src/linking/automatic/citations/aliases";
import { citationTokens } from "../../../src/linking/automatic/citations/text";
import { planMaxLink } from "../../../src/linking/plan";

/*
 * Security review A8: lists built with `m.set(k, [...(m.get(k) ?? []), x])` and scans over the whole
 * line per character were quadratic — 12 s (plan, on the UI thread), 24.6 s (aliases) at 40,000
 * items. Measured as GROWTH, not as wall time, so a loaded machine does not fail them: four times the
 * input must cost well under the sixteen times a quadratic path costs.
 */
const time = (f: () => unknown): number => {
  const t = performance.now();
  f();
  return performance.now() - t;
};
/** the best of three runs (less noise), at n and at 4n */
function growth(run: (n: number) => unknown, n: number): number {
  const best = (k: number) => Math.min(time(() => run(k)), time(() => run(k)), time(() => run(k)));
  run(n); // warm up
  return best(4 * n) / Math.max(best(n), 1);
}

describe("linear on hostile sizes", () => {
  it("max-link plan: a base with many commentaries", () => {
    const plan = (n: number) => {
      const base = { key: "b", title: "בראשית", origin: "personal" as const };
      return planMaxLink({ selected: ["b"], library: [base, ...Array.from({ length: n }, (_, i) => ({ key: `c${i}`, title: `פירוש${i} על בראשית`, origin: "personal" as const, bases: ["b"] }))] });
    };
    expect(growth(plan, 5_000)).toBeLessThan(8);
  }, 120_000);

  it("citations alias index: many books with one title", () => {
    const build = (n: number) => AliasIndex.build(Array.from({ length: n }, (_, i) => ({ book: { key: `k${i}`, title: "ספר", origin: "personal" as const } })));
    expect(growth(build, 5_000)).toBeLessThan(8);
  }, 120_000);

  it("citation tokens of a line of '&'", () => {
    expect(growth((n) => citationTokens("&".repeat(n)), 50_000)).toBeLessThan(8);
  }, 120_000);
});
