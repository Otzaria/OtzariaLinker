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
  it("small bounded quantifiers (the presets) are still fine", () => {
    for (const good of ["\d{1,4}", "[א-ת]{1,6}\s{1,3}\d{1,4}\.x{0,2}"]) expect(checkCustomPattern(good).ok, good).toBe(true);
  });
});
