import { describe, expect, it } from "vitest";
import { boundQuantifiers, checkCustomPattern, QUANTIFIER_CAP } from "../../../../src/core/text/safe-regex";

describe("bounded quantifiers cannot bypass the ReDoS guard (QA round 2, A)", () => {
  it("three wide bounded quantifiers in a row are refused, not accepted", () => {
    // before the fix this was accepted and ".test('a'.repeat(1000))" did not return in 20 s
    expect(checkCustomPattern("a{1,500}a{1,500}a{1,500}b").ok).toBe(false);
    expect(checkCustomPattern("a{1,30}a{1,30}a{1,30}b").ok).toBe(false);
  });
  it("the width of a {n,m} range is capped like an unbounded one", () => {
    expect(boundQuantifiers("x{1,500}")).toBe(`x{1,${1 + QUANTIFIER_CAP}}`);
    expect(boundQuantifiers("x{3,4}")).toBe("x{3,4}");
    expect(boundQuantifiers("x{500}")).toBe("x{500}");
  });
  it("what is accepted with wide quantifiers runs fast on a long line", () => {
    const c = checkCustomPattern("a{1,500}a{1,500}b");
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    const t0 = performance.now();
    c.regex.test("a".repeat(2000));
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it("a chain of NARROW bounded quantifiers over the same letters is refused (Issue #41 B16)", () => {
    // each a{1,8} passed the width rule; k=6 took 1 s on a 200-character line and k=7 12-14 s, and the
    // cost multiplies by 8 per link — on a 20,000-character line k=5 alone is minutes
    for (const k of [5, 6, 7, 10]) expect(checkCustomPattern(`${"a{1,8}".repeat(k)}b`).ok, `k=${k}`).toBe(false);
    expect(checkCustomPattern("[א-ת]{1,8}[א-ת]{1,8}[א-ת]{1,8}[א-ת]{1,8}[א-ת]{1,8}x").ok).toBe(false);
  });
  it("two unbounded quantifiers plus narrow bounded ones over the same letters are refused (Issue #41 B16)", () => {
    // accepted before: 0.8 s on a 200-character line
    expect(checkCustomPattern("a*a*a{1,8}a{1,8}b").ok).toBe(false);
    expect(checkCustomPattern(".*x.*y.{1,8}z").ok).toBe(false);
  });
  it("ambiguity from alternation counts, not only from quantifiers (Issue #41 B16)", () => {
    // no quantifier at all: 20 groups that match the same letter took 10 s on a 200-character line
    expect(checkCustomPattern(`${"(?:a|a)".repeat(20)}b`).ok).toBe(false);
    expect(checkCustomPattern(`${"(?:a|aa)".repeat(20)}b`).ok).toBe(false);
    // and an optional group is a choice of two
    expect(checkCustomPattern(`${"(?:a|aa)?".repeat(16)}b`).ok).toBe(false);
  });
  it("back-references stay refused, by number and by name (Issue #41 B16)", () => {
    expect(checkCustomPattern("(a)x\\1").ok).toBe(false);
    expect(checkCustomPattern("(?<n>a)x\\k<n>").ok).toBe(false);
  });
  it("adjacent quantifiers over DIFFERENT characters do not multiply: such patterns stay accepted", () => {
    for (const good of [
      "[א-ת]{1,6}\\s{1,3}\\d{1,4}\\.x{0,2}",
      "\\s?[א-ת]+\\s?\\d+",
      "סימן\\s{1,2}[א-ת]{1,4}\\s{1,2}סעיף\\s{1,2}[א-ת]{1,4}\\s{1,2}ס\"ק\\s{1,2}[א-ת]{1,4}",
      "\\d{1,4}[.:]\\s{0,2}[א-ת]{2,8}\\s{0,2}\\d{1,4}",
    ])
      expect(checkCustomPattern(good).ok, good).toBe(true);
  });
  it("small bounded quantifiers (the presets) are still fine", () => {
    for (const good of ["\d{1,4}", "[א-ת]{1,6}\s{1,3}\d{1,4}\.x{0,2}"]) expect(checkCustomPattern(good).ok, good).toBe(true);
  });
});
