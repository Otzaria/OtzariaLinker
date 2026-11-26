import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { parseGuidedRecord } from "../../../src/state/guided-flow";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * V7 §3.7, issues #26 and #45: a commentary aimed at several target books, in the guided plan. The user adds target books to a
 * commentary (its automatic base stays), chooses which one is primary and in what order the others are searched, and whether a
 * line that names no target is linked to the primary as usual or only for review — the engine's TargetHierarchy (PlanChoices
 * .targets, PR2). Removing the added books takes the commentary back to the automatic plan.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"][n]!;
const commentary = (title: string) => ({
  path: `${title}.txt`,
  blob: new Blob([strToU8(["<h1>" + title + "</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat()].join("\n"))]),
});
const A = "ביאור א על בראשית";
const B = "ביאור ב על בראשית";
const RASHI = 'רש"י על בראשית';
const ONKELOS = "תרגום אונקלוס על בראשית";

async function ready() {
  const store = new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
  const g = store.guided;
  g.start();
  await g.addBooks([commentary(A), commentary(B)]);
  await g.addBases([DB]);
  return { g, store };
}
/** every book a pair step of the commentary runs against */
const targetsOf = (g: Awaited<ReturnType<typeof ready>>["g"], dep: string) =>
  [...new Set(g.plan.value!.steps.flatMap((s) => (s.kind === "pair" && s.relation.dependant.title === dep && s.relation.kind === "commentary" ? [s.relation.base.title] : [])))].sort();
const hierarchyOf = (g: Awaited<ReturnType<typeof ready>>["g"], dep: string) => g.plan.value!.hierarchies?.find((h) => h.dependant.title === dep);

describe("guided flow — several target books for one commentary (V7 §3.7)", () => {
  it("adding target books keeps the automatic base, adds the chosen ones, and the plan infers the primary one", async () => {
    const { g } = await ready();
    // the plan's own: the base; רש"י is searched only for the lines that name it (an intermediate commentator), not a target
    expect(g.targetsOf(A)).toEqual([{ title: "בראשית", key: expect.any(String), role: "equal", added: false }]);
    g.setExtraTargets(A, [RASHI, ONKELOS]);
    expect(targetsOf(g, A)).toEqual(["בראשית", ONKELOS, RASHI].sort());
    // the other commentary is untouched
    expect(g.targetsOf(B).map((t) => t.title)).toEqual(["בראשית"]);
    const h = hierarchyOf(g, A)!;
    expect(h.primary.title).toBe("בראשית");
    expect(h.inferred).toBe(true);
    expect(g.targetsOf(A).map((t) => t.title)).toEqual(["בראשית", RASHI, ONKELOS]);
  });

  it("the user sets the primary, the priority of the others and the fallback; the plan applies it as given", async () => {
    const { g } = await ready();
    g.setExtraTargets(A, [RASHI, ONKELOS]);
    g.setTargetHierarchy(A, { primary: RASHI, secondary: [ONKELOS, "בראשית"], fallback: "review" });
    const h = hierarchyOf(g, A)!;
    expect(h.inferred).toBe(false);
    expect(h.primary.title).toBe(RASHI);
    expect(h.secondary.map((b) => b.title)).toEqual([ONKELOS, "בראשית"]);
    expect(h.fallback).toBe("review");
    expect(g.targetsOf(A).map((t) => [t.title, t.role])).toEqual([[RASHI, "primary"], [ONKELOS, "secondary"], ["בראשית", "secondary"]]);
  });

  it("a removed target leaves the hierarchy too; removing every added one goes back to the automatic plan", async () => {
    const { g } = await ready();
    const before = JSON.stringify(g.plan.value!.steps.map((s) => s.id));
    g.setExtraTargets(A, [RASHI, ONKELOS]);
    g.setTargetHierarchy(A, { primary: RASHI, secondary: [ONKELOS, "בראשית"] });
    g.removeTarget(A, ONKELOS);
    expect(g.extraTargets.value[A]).toEqual([RASHI]);
    expect(g.targets.value[A]?.secondary).toEqual(["בראשית"]);
    g.removeTarget(A, RASHI);
    expect(g.extraTargets.value[A]).toBeUndefined();
    expect(g.targets.value[A]).toBeUndefined();
    expect(JSON.stringify(g.plan.value!.steps.map((s) => s.id))).toBe(before);
  });

  it("a target book open in two sources: the copy the user ticked is the one planned, also in a continued flow", async () => {
    const onkelosCopy = { path: `${ONKELOS}.txt`, blob: new Blob([strToU8(`<h1>${ONKELOS}</h1>\n<h2>פרק א</h2>\nפסוק א`)]) };
    const { g, store } = await ready();
    await g.addBases([onkelosCopy]);
    const copies = store.booksByTitle.value.get(ONKELOS)!;
    expect(copies).toHaveLength(2);
    const second = copies[1]!;
    const label = store.sources.value.find((s) => s.books.some((b) => b.key === second.key))!.info.label;
    g.setExtraTargets(A, [ONKELOS], { [ONKELOS]: second.key });
    const baseKeys = (gg: typeof g) => gg.plan.value!.steps.flatMap((s) => (s.kind === "pair" && s.relation.dependant.title === A && s.relation.base.title === ONKELOS ? [s.relation.base.key] : []));
    expect(baseKeys(g)).toEqual([second.key]);
    expect(g.targetsOf(A).find((t) => t.title === ONKELOS)?.key).toBe(second.key);
    expect(g.addedTargetKey(A, ONKELOS)).toBe(second.key);
    // removing another added target keeps the chosen copy
    g.setExtraTargets(A, [ONKELOS, RASHI]);
    g.removeTarget(A, RASHI);
    expect(baseKeys(g)).toEqual([second.key]);

    // the saved flow names the copy by its source (session keys do not outlive the session); a continued flow binds it again
    const rec = parseGuidedRecord(JSON.stringify(g.record()))!;
    expect(rec.extraTargets).toEqual({ [A]: [ONKELOS] });
    expect(rec.extraTargetSources).toEqual({ [A]: { [ONKELOS]: label } });
    const store2 = new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
    const g2 = store2.guided;
    g2.saved.value = rec;
    g2.continueSaved();
    await g2.addBooks([commentary(A), commentary(B)]);
    await g2.addBases([DB]);
    await g2.addBases([onkelosCopy]);
    const copy2 = store2.sources.value.find((s) => s.info.label === label)!.books.find((b) => b.title === ONKELOS)!;
    expect(store2.booksByTitle.value.get(ONKELOS)![0]!.key).not.toBe(copy2.key);
    expect(baseKeys(g2)).toEqual([copy2.key]);

    // an older record (titles only) still parses, and binds by title
    const old = parseGuidedRecord(JSON.stringify({ ...rec, extraTargetSources: undefined }))!;
    expect(old.extraTargets).toEqual({ [A]: [ONKELOS] });
    expect(old.extraTargetSources).toBeUndefined();
    expect(parseGuidedRecord(JSON.stringify({ ...rec, extraTargetSources: { [A]: { [ONKELOS]: 3 }, __proto__x: 1 } }))!.extraTargetSources).toBeUndefined();
  });

  it("is kept in the saved flow and comes back clean", async () => {
    const { g } = await ready();
    g.setExtraTargets(A, [RASHI]);
    g.setTargetHierarchy(A, { primary: RASHI, fallback: "review" });
    const rec = parseGuidedRecord(JSON.stringify(g.record()))!;
    expect(rec.extraTargets).toEqual({ [A]: [RASHI] });
    expect(rec.targets).toEqual({ [A]: { primary: RASHI, fallback: "review" } });
    const bad = parseGuidedRecord(JSON.stringify({ ...rec, extraTargets: { [A]: [RASHI, 7], __proto__x: "x", b: [] }, targets: { [A]: { primary: 3 }, [B]: { primary: "בראשית", fallback: "bogus", secondary: ["x", 1] } } }))!;
    expect(bad.extraTargets).toEqual({ [A]: [RASHI] });
    expect(bad.targets).toEqual({ [B]: { primary: "בראשית", secondary: ["x"] } });
  });
});
