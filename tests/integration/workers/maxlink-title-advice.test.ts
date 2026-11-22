import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { EngineResult } from "../../../src/linking/automatic";
import { pairMethodKey, planMaxLink } from "../../../src/linking/plan";
import { SourceRegistry } from "../../../src/sources/registry";
import { maxlinkJob } from "../../../src/workers/maxlink-job";

/*
 * Fix round, claim 2 in the job: the title gate advises. A step whose titles are doubtful (partial, undecided) runs with a note that says
 * why; a step the user forced although the check did not approve it runs with a warning and nothing of it is "certain" (never approved in
 * bulk); a step the check approved is untouched.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"][n]!;
const text = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const FITS = text("ביאור על בראשית.txt", ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat()]);
// one chapter the base has (פרק א, two verses) and nine blocks under names it does not have: 10% of the lines are under the base's titles
const NAMES = ["", "ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שביעי", "שמיני", "תשיעי"];
const GREY = text("חידושים על בראשית.txt", ["<h1>חידושים על בראשית</h1>", "<h2>פרק א</h2>", "<h3>פסוק א</h3>", "ביאור לפסוק א", "<h3>פסוק ב</h3>", "ביאור לפסוק ב", ...Array.from({ length: 9 }, (_, i) => [`<h2>שער ${NAMES[i + 1]}</h2>`, `<h3>סעיף א</h3>`, "מילים של פסקה", "<h3>סעיף ב</h3>", "עוד מילים"]).flat()]);
// no title of the base's among its own
const OTHER = text("פירוש מיוחד על בראשית.txt", ["<h1>פירוש מיוחד על בראשית</h1>", "<h2>מדור הזהב</h2>", "מילים של פסקה", "<h2>מדור הכסף</h2>", "מילים של פסקה", "<h2>מדור הנחושת</h2>", "מילים של פסקה"]);

async function run(file: { path: string; blob: Blob }, title: string, forced = false) {
  const reg = new SourceRegistry();
  const res = await reg.open([DB, file]);
  const all = res.sources.flatMap((s) => s.books);
  const dep = all.find((b) => b.title === title)!;
  const base = all.find((b) => b.title === "בראשית")!;
  const choices = forced ? { methods: { [pairMethodKey(dep.title, base.title)]: ["headings" as const] } } : undefined;
  const plan = planMaxLink({ selected: [dep.key], library: all, singleEngines: [], ...(choices && { choices }) });
  const res2 = await maxlinkJob(reg, plan.steps, {}, {});
  const headings = res2.items.find((i) => i.stepId.startsWith("headings|"))!;
  return { plan, headings, items: res2.items };
}
const noteCodes = (r: { result?: EngineResult }) => r.result?.notes.map((n) => n.code) ?? [];
const found = (r: { result?: EngineResult }) => r.result?.suggestions ?? [];

describe("the title gate advises", () => {
  it("titles that fit: no note, no warning, certain stays certain (control)", async () => {
    const { headings } = await run(FITS, "ביאור על בראשית");
    expect(noteCodes(headings).filter((c) => c.startsWith("title-fit/"))).toEqual([]);
    expect(found(headings).filter((s) => s.confidence === "certain")).toHaveLength(10);
  });

  it("undecided titles: the step runs, and a note says why it is doubtful", async () => {
    const { headings } = await run(GREY, "חידושים על בראשית");
    expect(noteCodes(headings)).toContain("title-fit/undecided");
    expect(noteCodes(headings)).not.toContain("title-fit/skipped");
    expect(found(headings).length).toBeGreaterThan(0);
    expect(headings.result!.notes.find((n) => n.code === "title-fit/undecided")!.text).toContain("10%");
  });

  it("titles none of which is the base's: skipped, with the reasons (as before)", async () => {
    const { headings } = await run(OTHER, "פירוש מיוחד על בראשית");
    expect(noteCodes(headings)).toContain("title-fit/skipped");
    expect(found(headings)).toHaveLength(0);
    expect(headings.result!.notes.find((n) => n.code === "title-fit/skipped")!.text).toContain("0%");
  });

  it("forcing the method for the pair runs it where the gate would skip, and says so (here it finds nothing: none of its titles is the base's)", async () => {
    const { headings, plan } = await run(OTHER, "פירוש מיוחד על בראשית", true);
    expect(noteCodes(headings)).not.toContain("title-fit/skipped");
    expect(noteCodes(headings)).toContain("title-fit/forced");
    const step = plan.steps.find((s) => s.engine === "headings")!;
    expect(step.kind === "pair" && step.titleForced).toBe(true);
    expect(headings.error).toBeUndefined();
  });

  it("forcing an undecided pair: what it finds carries the warning, and nothing is 'certain' (never approved in bulk)", async () => {
    const free = await run(GREY, "חידושים על בראשית");
    expect(found(free.headings).some((s) => s.confidence === "certain")).toBe(true); // control: unforced, the two lines under the base's titles are certain
    const { headings } = await run(GREY, "חידושים על בראשית", true);
    const s = found(headings);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.confidence !== "certain")).toBe(true);
    expect(s.every((x) => x.warnings.some((w) => w.code === "title-fit/forced"))).toBe(true);
    expect(noteCodes(headings)).toContain("title-fit/forced");
  });

  it("forcing a method whose titles DO fit adds nothing", async () => {
    const { headings } = await run(FITS, "ביאור על בראשית", true);
    expect(noteCodes(headings).filter((c) => c.startsWith("title-fit/"))).toEqual([]);
    expect(found(headings).filter((s) => s.confidence === "certain")).toHaveLength(10);
  });
});
