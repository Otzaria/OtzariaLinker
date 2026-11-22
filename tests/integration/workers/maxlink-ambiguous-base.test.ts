import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { planMaxLink } from "../../../src/linking/plan";
import { SourceRegistry } from "../../../src/sources/registry";
import { maxlinkJob } from "../../../src/workers/maxlink-job";

/*
 * Fix round, claim 9: the same shape as the v52 case on real structures. "בראשית" is a book of the database AND a text file; the commentary is
 * a text file too, so the planner's own-source rule picks the text "בראשית". Nothing says that is the book the commentary is on, so what the
 * job finds against it is at most "possible" (never "certain"/"high", which are what a person approves in bulk), with the reason.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"][n]!;
const text = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const BIUR = text("ביאור על בראשית.txt", ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat()]);
const OWN_BASE = text("בראשית.txt", ["<h1>בראשית</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `פסוק ${i + 1} של הנוסח האישי`]).flat()]);

async function setup(files: { path: string; blob: Blob }[]) {
  const reg = new SourceRegistry();
  const res = await reg.open(files);
  const all = res.sources.flatMap((s) => s.books);
  return { reg, all, dep: all.find((b) => b.title === "ביאור על בראשית")! };
}
const confidences = (res: Awaited<ReturnType<typeof maxlinkJob>>, engine: string) => new Set(res.items.filter((i) => i.stepId.startsWith(`${engine}|`)).flatMap((i) => i.result?.suggestions.map((s) => s.confidence) ?? []));

describe("a base chosen between two books of the same title", () => {
  it("control: with ONE book of that title the headings step is certain, as before", async () => {
    const { reg, all, dep } = await setup([DB, BIUR]);
    const plan = planMaxLink({ selected: [dep.key], library: all, singleEngines: [] });
    expect(confidences(await maxlinkJob(reg, plan.steps, {}, {}), "headings")).toContain("certain");
  });

  it("two books titled בראשית: nothing the job finds against the rule-chosen one is certain or high, and the reason is on each suggestion", async () => {
    const { reg, all, dep } = await setup([DB, BIUR, OWN_BASE]);
    const plan = planMaxLink({ selected: [dep.key], library: all, singleEngines: [] });
    const headings = plan.steps.find((s) => s.engine === "headings")!;
    expect(headings.kind === "pair" && headings.ambiguousBase).toBe(true);
    const res = await maxlinkJob(reg, plan.steps, {}, {});
    const found = res.items.flatMap((i) => i.result?.suggestions ?? []);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((s) => s.confidence !== "certain" && s.confidence !== "high")).toBe(true);
    expect(found.every((s) => s.warnings.some((w) => w.code === "maxlink/ambiguous-base"))).toBe(true);
    expect(res.items.every((i) => i.result?.notes.some((n) => n.code === "maxlink/ambiguous-base") ?? true)).toBe(true);
  });

  it("naming the very book (a pair with its key) lifts the cap: that is the user's decision", async () => {
    const { reg, all, dep } = await setup([DB, BIUR, OWN_BASE]);
    const base = all.find((b) => b.title === "בראשית" && b.key !== all.find((x) => x.title === "בראשית" && x.origin === "personal")?.key) ?? all.find((b) => b.title === "בראשית")!;
    const plan = planMaxLink({ selected: [dep.key], library: all, singleEngines: [], choices: { pairs: [{ dependant: dep.title, base: "בראשית", dependantKey: dep.key, baseKey: base.key }] } });
    const res = await maxlinkJob(reg, plan.steps, {}, {});
    expect(confidences(res, "headings")).toContain("certain");
  });
});
