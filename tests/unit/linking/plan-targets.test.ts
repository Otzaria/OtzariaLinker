import { describe, expect, it } from "vitest";
import { stepsSignature } from "../../../src/linking/batch-job";
import { competingTargets, planMaxLink, type PlanBook, type UserPair } from "../../../src/linking/plan";

/*
 * #41 B13, issues #10 and #45, V7 §2.7: a commentary on the Shulchan Aruch linked against the Shulchan Aruch AND its commentators (the
 * user's "more target books"). Every target was a full equal, so a line went to whichever book its words matched a little better.
 * Now the target hierarchy decides: the primary base gets every line, a secondary target only the lines that name it (by ד"ה or by
 * seif katan), and it never competes with the primary on score. Book titles and keys only; no book text.
 */
const book = (key: string, title: string): PlanBook => ({ key, title, origin: "otzaria" });
const SA = book("s:1", "שולחן ערוך, יורה דעה");
const SHACH = book("s:2", "שפתי כהן על שולחן ערוך יורה דעה");
const TAZ = book("s:3", "טורי זהב על שולחן ערוך יורה דעה");
const COMM = book("s:9", "ביאור על שולחן ערוך יורה דעה");
const lib = [SA, SHACH, TAZ, COMM];
const pair = (b: PlanBook): UserPair => ({ dependant: COMM.title, base: b.title, dependantKey: COMM.key, baseKey: b.key });
const pairSteps = (p: ReturnType<typeof planMaxLink>) => p.steps.filter((s) => s.kind === "pair");
const against = (p: ReturnType<typeof planMaxLink>, b: PlanBook) => pairSteps(p).filter((s) => s.target.key === b.key);

describe("the target hierarchy of a commentary with several targets (#45, #10, V7 §2.7)", () => {
  it("inferred: the Shulchan Aruch is primary (the others are written on it); the Shach and the Taz only get the lines that name them", () => {
    const p = planMaxLink({ selected: [COMM.key], library: lib, singleEngines: [], choices: { pairs: [pair(SA), pair(SHACH), pair(TAZ)] } });
    expect(p.hierarchies).toEqual([expect.objectContaining({ primary: expect.objectContaining({ key: SA.key }), inferred: true, fallback: "primary" })]);
    expect(p.hierarchies![0]!.secondary.map((b) => b.key)).toEqual([SHACH.key, TAZ.key]);
    for (const sec of [SHACH, TAZ]) {
      const st = against(p, sec);
      expect(st.map((s) => s.engine)).toEqual(["dibur-hamatchil"]);
      expect(st.every((s) => s.kind === "pair" && s.targetRole === "secondary" && s.options?.["addressedOnly"] === true)).toBe(true);
    }
    expect(against(p, SA).length).toBeGreaterThan(0);
    expect(against(p, SA).every((s) => s.kind === "pair" && s.targetRole === "primary")).toBe(true);
    expect(p.books[0]!.decisions.join(" ")).toContain("היעד הראשי");
    // a secondary target is no competitor of the primary (merge.ts candidateBooks)
    expect(competingTargets(p.steps)).not.toContain(SHACH.key);
  });

  it("the user's hierarchy wins: priority order and the fallback 'review' for the primary", () => {
    const p = planMaxLink({
      selected: [COMM.key],
      library: lib,
      singleEngines: [],
      choices: { pairs: [pair(SA), pair(SHACH), pair(TAZ)], targets: { [COMM.title]: { primary: SA.title, secondary: [TAZ.title, SHACH.title], fallback: "review" } } },
    });
    expect(p.hierarchies![0]!.inferred).toBe(false);
    expect(p.hierarchies![0]!.secondary.map((b) => b.key)).toEqual([TAZ.key, SHACH.key]);
    expect(against(p, SA).every((s) => s.kind === "pair" && s.targetRole === "primary-review")).toBe(true);
    expect(stepsSignature(p.steps)).toContain("primary-review");
  });

  it("targets that are not one base and its commentators: no hierarchy, the targets stay equals", () => {
    const other = book("s:4", "ספר אחר");
    const p = planMaxLink({ selected: [COMM.key], library: [...lib, other], singleEngines: [], choices: { pairs: [pair(SA), pair(other)] } });
    expect(p.hierarchies).toBeUndefined();
    expect(pairSteps(p).every((s) => s.kind === "pair" && s.targetRole === undefined)).toBe(true);
  });
});
