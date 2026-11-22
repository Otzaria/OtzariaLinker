import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { parseGuidedRecord } from "../../../src/state/guided-flow";
import { pairMethodKey } from "../../../src/linking/plan";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Per-pair controls of the guided flow (V6 3.4): a pair switched off, its link type, its confidence threshold. They ride
 * on the plan's own relations (never an explicit pair list), so a pair nobody touched stays automatic.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"][n]!;
const commentary = (title: string) => ({
  path: `${title}.txt`,
  blob: new Blob([strToU8(["<h1>" + title + "</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat()].join("\n"))]),
});

async function ready() {
  const store = new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
  const g = store.guided;
  g.start();
  await g.addBooks([commentary("ביאור א על בראשית"), commentary("ביאור ב על בראשית")]);
  await g.addBases([DB]);
  return { g };
}
/** the pairs of the plan, "dependant>base": each commentary here is on בראשית and, through it, on רש"י על בראשית */
const pairs = (g: Awaited<ReturnType<typeof ready>>["g"]) => [...new Set(g.plan.value!.steps.filter((s) => s.kind === "pair").map((s) => `${s.source.title}>${s.target.title}`))].sort();
const A = "ביאור א על בראשית";
const B = "ביאור ב על בראשית";

describe("guided flow — per-pair controls", () => {
  it("by default nothing is switched off and nothing is overridden", async () => {
    const { g } = await ready();
    expect(g.pairControls.value).toEqual({});
    expect(pairs(g)).toContain(`${A}>בראשית`);
    expect(pairs(g)).toContain(`${B}>בראשית`);
    expect(g.plan.value!.unsuitable.filter((u) => u.reason === "disabled")).toEqual([]);
  });

  it("a pair switched off leaves the plan and is listed as disabled; the other pair is untouched; switching on goes back", async () => {
    const { g } = await ready();
    const before = pairs(g);
    g.setPairControl(A, "בראשית", { enabled: false });
    // only that pair goes: the same commentary's pair with its other base, and the other commentary's pairs, stay
    expect(pairs(g)).toEqual(before.filter((x) => x !== `${A}>בראשית`));
    expect(pairs(g)).toContain(`${B}>בראשית`);
    const off = g.plan.value!.unsuitable.filter((u) => u.reason === "disabled");
    expect(off.length).toBeGreaterThan(0);
    expect(off.every((u) => u.dependant.title === A && u.base.title === "בראשית")).toBe(true);
    g.setPairControl(A, "בראשית", { enabled: true });
    expect(g.pairControls.value).toEqual({});
    expect(pairs(g)).toEqual(before);
  });

  it("the link type and the confidence threshold of one pair reach the plan", async () => {
    const { g } = await ready();
    g.setPairControl(B, "בראשית", { connectionType: "targum", minConfidence: "high" });
    const key = pairMethodKey(B, "בראשית");
    expect(g.plan.value!.minConfidence?.[key]).toBe("high");
    const steps = g.plan.value!.steps.filter((s) => s.kind === "pair");
    const mine = steps.filter((s) => s.source.title === B && s.target.title === "בראשית");
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((s) => s.options?.declaredType === "targum")).toBe(true);
    // the other pairs keep what the plan chose on its own
    expect(steps.filter((s) => !(s.source.title === B && s.target.title === "בראשית")).some((s) => s.options?.declaredType === "targum")).toBe(false);
    expect(Object.keys(g.plan.value!.minConfidence ?? {})).toEqual([key]);
  });

  it("the controls of a saved record come back clean: unknown fields and values are dropped", () => {
    const rec = parseGuidedRecord(JSON.stringify({ v: 1, step: "books", sources: [], purpose: "private", links: 0, done: false, savedAt: 1,
      pairControls: { "x>y": { enabled: false, connectionType: " targum ", minConfidence: "high", extra: 1 }, "p>q": { enabled: true, minConfidence: "bogus" }, bad: 7 } }));
    expect(rec?.pairControls).toEqual({ "x>y": { enabled: false, connectionType: "targum", minConfidence: "high" } });
  });
});
