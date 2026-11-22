import { describe, expect, it } from "vitest";
import { planMaxLink, type PlanBook } from "../../../src/linking/plan";
import { stepsSignature } from "../../../src/linking/batch-job";

/*
 * Fix round, claim 9 (shape of the v52 case, invented numbers, no book text): "ספר נר על ברכות" is a personal book, "ברכות" is BOTH a personal
 * book and an official one. The planner picks the base by the dependant's own source, which is a rule, not evidence: the steps against such a
 * base say so (PlanStep.ambiguousBase), and the job lowers what they find to "possible" (tests/integration/workers/maxlink-ambiguous-base.test.ts).
 * A base the user chose themselves (a pair with the book's key, or the source for the bases) is not ambiguous.
 */
const book = (key: string, title: string, origin: PlanBook["origin"], more: Partial<PlanBook> = {}): PlanBook => ({ key, title, origin, ...more });
const lib = [book("s1:103", "ברכות", "sefaria", { lineCount: 2875 }), book("s2:9386", "ברכות", "personal", { lineCount: 2779 }), book("s2:7839", "ספר נר על ברכות", "personal", { lineCount: 639 })];
const pairs = (p: ReturnType<typeof planMaxLink>) => p.steps.filter((s) => s.kind === "pair");

describe("planMaxLink — a base chosen between books of the same title", () => {
  it("the steps against it say the base was chosen by a rule, and the book's decisions say why", () => {
    const p = planMaxLink({ selected: ["s2:7839"], library: lib, singleEngines: [] });
    expect(pairs(p).length).toBeGreaterThan(0);
    expect(pairs(p).every((s) => s.kind === "pair" && s.ambiguousBase === true)).toBe(true);
    expect(p.books[0]!.decisions.join(" ")).toContain("יש עוד ספר בשם");
  });

  it("a title only one book has: no flag", () => {
    const only = [book("s1:103", "ברכות", "sefaria"), book("s2:7839", "ספר נר על ברכות", "personal")];
    const p = planMaxLink({ selected: ["s2:7839"], library: only, singleEngines: [] });
    expect(pairs(p).every((s) => s.kind === "pair" && s.ambiguousBase === undefined)).toBe(true);
    expect(p.books[0]!.decisions.join(" ")).not.toContain("יש עוד ספר בשם");
  });

  it("the user chose the source for the bases, or named the very book: no flag", () => {
    const preferred = planMaxLink({ selected: ["s2:7839"], library: lib, singleEngines: [], preferSource: "s1" });
    expect(pairs(preferred).every((s) => s.kind === "pair" && s.ambiguousBase === undefined && s.target.key === "s1:103")).toBe(true);
    const named = planMaxLink({ selected: ["s2:7839"], library: lib, singleEngines: [], choices: { pairs: [{ dependant: "ספר נר על ברכות", base: "ברכות", dependantKey: "s2:7839", baseKey: "s1:103" }] } });
    expect(pairs(named).length).toBeGreaterThan(0);
    expect(pairs(named).every((s) => s.kind === "pair" && s.ambiguousBase === undefined && s.target.key === "s1:103")).toBe(true);
  });

  it("the flag is part of the step signature (a book run before it existed runs again once), and an unflagged step's signature is unchanged", () => {
    const flagged = planMaxLink({ selected: ["s2:7839"], library: lib, singleEngines: [] }).steps;
    const named = planMaxLink({ selected: ["s2:7839"], library: lib, singleEngines: [], preferSource: "s2" }).steps;
    expect(stepsSignature(flagged)).not.toBe(stepsSignature(named));
    expect(stepsSignature(named)).not.toContain("amb");
  });
});
