import { describe, expect, it } from "vitest";
import { ENGINES } from "../../../src/linking/automatic";
import { ENGINE_OPTION_SPECS } from "../../../src/linking/automatic/option-specs";

/*
 * V7 round 2, item 12: every method is kept and none is duplicated. The five engines, and v3's modes as OPTIONS of them, not as engines
 * of their own: "לפי כותרות" content / structural / subsections and "פסקאות כסעיפים" (headings: headingMatch, paragraphsAsSections),
 * "לפי תגיות" and "לפי Regex" (pattern: tag, regex), the range kinds of runMatches (every pair engine: sourceRange, targetRange).
 * Each engine's own tests: tests/unit/linking/<engine>/ and tests/integration/linking/<engine>/.
 */
describe("the engines: five, each once, v3's modes as their options", () => {
  it("the registry holds exactly the five engines", () => {
    expect(ENGINES.map((e) => e.id)).toEqual(["headings", "dibur-hamatchil", "footnotes", "citations", "pattern"]);
    expect(new Set(ENGINES.map((e) => e.title)).size).toBe(ENGINES.length);
  });

  it("v3's ways of matching are options of the one engine that does them", () => {
    const keys = (id: keyof typeof ENGINE_OPTION_SPECS) => ENGINE_OPTION_SPECS[id].map((s) => s.key);
    const match = ENGINE_OPTION_SPECS.headings.find((s) => s.key === "headingMatch");
    expect(match?.kind === "select" && match.choices.map(([v]) => v)).toEqual(["structure", "content", "leaves"]);
    expect(keys("headings")).toContain("paragraphsAsSections");
    expect(keys("pattern")).toEqual(expect.arrayContaining(["tag", "regex"]));
    for (const id of ["headings", "dibur-hamatchil", "footnotes", "pattern"] as const) expect(keys(id)).toEqual(expect.arrayContaining(["sourceRange", "targetRange"]));
    // the single-book engine has its own range option (a whole cited unit or its first line), not the pair engines'
    expect(keys("citations")).toContain("ranges");
    expect(keys("citations")).not.toContain("sourceRange");
  });
});
