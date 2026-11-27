import { describe, expect, it } from "vitest";
import { backtrackingCost } from "../../../../src/core/text/regex-cost";
import { boundQuantifiers, checkCustomPattern, MAX_BACKTRACKING_COST, MAX_CUSTOM_REGEX_INPUT, QUANTIFIER_CAP } from "../../../../src/core/text/safe-regex";

const cost = (p: string, flags = "") => backtrackingCost(boundQuantifiers(p), flags, { cap: QUANTIFIER_CAP, budget: Infinity });

describe("backtrackingCost (Issue #41 B16)", () => {
  it("adjacent ranges over the same characters multiply; over different characters they add", () => {
    expect(cost("a{1,8}a{1,8}a{1,8}b")).toBeGreaterThan(8 * 8 * 8);
    expect(cost("a{1,8}\\s{1,8}\\d{1,8}b")).toBeLessThan(8 * 8);
    // every link multiplies by the width of the range
    expect(cost(`${"a{1,8}".repeat(5)}b`)).toBeGreaterThan(7 * cost(`${"a{1,8}".repeat(4)}b`));
  });

  it("a choice that runs into the end of the pattern succeeds there and costs nothing more", () => {
    expect(cost("x[א-ת]{1,8}(?:\\s[א-ת]{1,8})?")).toBeLessThan(100);
  });

  it("alternation: overlapping branches add up, branches that differ at a fixed place do not", () => {
    expect(cost("(?:a|a)(?:a|a)(?:a|a)(?:a|a)b")).toBeGreaterThanOrEqual(16);
    expect(cost("(?:סימן|סעיף|פרק|הלכה)\\s(?:סימן|סעיף|פרק|הלכה)\\s(?:סימן|סעיף|פרק|הלכה)")).toBeLessThan(200);
  });

  it("an optional group doubles what follows only when taking it and skipping it can both get far", () => {
    expect(cost(`${"(?:a|aa)?".repeat(10)}b`)).toBeGreaterThan(1024);
    expect(cost("(?:סימן\\s[א-ת]{1,4})?(?:סעיף\\s[א-ת]{1,4})?(?:ס\"ק\\s[א-ת]{1,4})?")).toBeLessThan(300);
  });

  it("under the i flag letters of the other case overlap; (?i:…) is read the wide way too", () => {
    const p = `${"a{1,8}A{1,8}".repeat(3)}b`;
    expect(cost(p)).toBeLessThan(MAX_BACKTRACKING_COST);
    expect(cost(p, "i")).toBeGreaterThan(MAX_BACKTRACKING_COST);
    expect(cost(`${"a{1,8}(?i:A{1,8})".repeat(3)}b`)).toBeGreaterThan(MAX_BACKTRACKING_COST);
  });

  it("a lookbehind's body is costed without discounts (it is matched backwards)", () => {
    expect(cost("(?<=a{1,8}a{1,8}a{1,8}a{1,8}a{1,8})b")).toBeGreaterThan(MAX_BACKTRACKING_COST);
  });
});

describe("whatever the guard accepts runs fast on the worst line it is given (Issue #41 B16)", () => {
  // the text every one of these shapes backtracks the most on: one character, MAX_CUSTOM_REGEX_INPUT times
  const line = "a".repeat(MAX_CUSTOM_REGEX_INPUT);
  const families: ((k: number) => string)[] = [
    (k) => `${"a{1,8}".repeat(k)}b`,
    (k) => `${"a{1,4}".repeat(k)}b`,
    (k) => `${"(?:a|aa)".repeat(k)}b`,
    (k) => `${"(?:a|a)".repeat(k)}b`,
    (k) => `${"a?".repeat(k)}${"a".repeat(k)}b`,
    (k) => `${"a*".repeat(Math.min(k, 2))}${"a{1,8}".repeat(k)}b`,
  ];
  for (const [i, family] of families.entries())
    it(`family ${i}: ${family(3)}`, () => {
      let accepted = 0;
      for (let k = 1; k <= 12; k++) {
        const c = checkCustomPattern(family(k));
        if (!c.ok) continue;
        accepted++;
        const t0 = performance.now();
        c.regex.lastIndex = 0;
        c.regex.test(line);
        expect(performance.now() - t0, family(k)).toBeLessThan(2000);
      }
      expect(accepted).toBeGreaterThan(0); // the small members of each family stay usable
    }, 60_000);
});
