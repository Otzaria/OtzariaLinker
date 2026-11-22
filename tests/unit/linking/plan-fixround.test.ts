import { describe, expect, it } from "vitest";
import { pairMethodKey, planMaxLink, type PlanBook } from "../../../src/linking/plan";
import type { EngineId } from "../../../src/linking/automatic";

/*
 * Fix round, claim 5: forcing a method (here dibur-hamatchil, for ONE pair by name) applies to the base-vs-commentary matching. The
 * independent engines — the notes engine of a notes book, the citations engine of every selected book — go on unless the user turned
 * them off (unticked them). The all-pairs form of the same rule is tested in tests/integration/state/guided-flow.test.ts.
 */
const book = (key: string, title: string, more: Partial<PlanBook> = {}): PlanBook => ({ key, title, origin: "otzaria", ...more });
const lib = [book("t:3", "ספר דוגמה"), book("t:4", "הערות לספר דוגמה"), book("t:1", 'רש"י על ספר דוגמה')];
const steps = (p: ReturnType<typeof planMaxLink>) => p.steps.map((s) => `${s.engine}:${s.source.title}${s.kind === "pair" ? `>${s.target.title}` : ""}`);
const force = (dep: string, base: string) => ({ methods: { [pairMethodKey(dep, base)]: ["dibur-hamatchil" as const] } });

describe("naming dibur-hamatchil for one pair", () => {
  it("a notes pair keeps its notes step: forcing is about the matching of base and commentary, not about the notes", () => {
    const p = planMaxLink({ singleEngines: [], selected: ["t:4"], library: lib, choices: force("הערות לספר דוגמה", "ספר דוגמה") });
    expect(steps(p)).toEqual(["dibur-hamatchil:הערות לספר דוגמה>ספר דוגמה", "footnotes:ספר דוגמה>הערות לספר דוגמה"]);
  });

  it("unless the user turned the notes engine off: then it is not added", () => {
    const engines = new Set<EngineId>(["headings", "dibur-hamatchil"]);
    const p = planMaxLink({ singleEngines: [], selected: ["t:4"], library: lib, engines, choices: force("הערות לספר דוגמה", "ספר דוגמה") });
    expect(steps(p)).toEqual(["dibur-hamatchil:הערות לספר דוגמה>ספר דוגמה"]);
  });

  it("naming footnotes too is not doubled", () => {
    const choices = { methods: { [pairMethodKey("הערות לספר דוגמה", "ספר דוגמה")]: ["dibur-hamatchil" as const, "footnotes" as const] } };
    const p = planMaxLink({ singleEngines: [], selected: ["t:4"], library: lib, choices });
    expect(steps(p).filter((s) => s.startsWith("footnotes"))).toHaveLength(1);
  });

  it("a commentary pair: dibur-hamatchil replaces headings for that pair, and the citations step of the book is still planned", () => {
    const p = planMaxLink({ selected: ["t:1"], library: lib, choices: force('רש"י על ספר דוגמה', "ספר דוגמה") });
    expect(steps(p)).toEqual(['dibur-hamatchil:רש"י על ספר דוגמה>ספר דוגמה', 'citations:רש"י על ספר דוגמה']);
  });
});
