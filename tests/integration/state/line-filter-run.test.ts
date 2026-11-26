import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import type { Suggestion } from "../../../src/linking/automatic";
import { defaultFormValues, toEngineOptions } from "../../../src/linking/automatic/option-specs";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * The line filter of issue #27 belongs to the RUN, not to one engine (findings #40 A1). The measured case: a commentary whose
 * "[א]" lines are 2, 5 and 8, with "א)" noise lines between them. The filter is chosen in the dibur-hamatchil form (the only form
 * where it is essential), and the run goes through the store exactly as the screens send it:
 *   - "every method that fits, merged" (RunForm: maxLink.pairPlan + maxLink.run with the form's options under its engine);
 *   - max-link (MaxLinkForm: maxLink.plan + maxLink.run with engineOptions per engine);
 *   - the guided flow (GuidedFlowState.run).
 * Before the fix only dibur-hamatchil saw the filter: the headings engine proposed the noise lines too, some of them "certain".
 * Synthetic neutral words; no book text.
 */
const text = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const BASE_TITLE = "ספר בסיס";
const COMM_TITLE = "ביאור על ספר בסיס";
const BASE = text(`${BASE_TITLE}.txt`, [
  `<h1>${BASE_TITLE}</h1>`,
  "<h2>פרק א</h2>",
  "אלפא בטא גמא דלתא הא וו זין חית טית יוד",
  "כף למד מם נון סמך עין פא צדי קוף ריש",
  "<h2>פרק ב</h2>",
  "שין תיו אלף בית גימל דלת הי ואו זיי חית",
]);
const COMM_LINES = [
  `<h1>${COMM_TITLE}</h1>`,
  "<h2>פרק א</h2>",
  "[א] אלפא בטא גמא: פירוש על הדברים האלה כאן",
  "א) כף למד מם נון: שורת רעש שאינה צריכה להיכנס",
  "ב) אלפא בטא גמא: עוד שורת רעש",
  "[ב] כף למד מם נון: ועוד פירוש לדברים",
  "ג) כף למד מם נון: שורת רעש שלישית",
  "<h2>פרק ב</h2>",
  "[ג] שין תיו אלף בית: פירוש לפרק השני",
  "ד) שין תיו אלף בית: שורת רעש אחרונה",
];
const COMM = text(`${COMM_TITLE}.txt`, COMM_LINES);
const WANTED = [2, 5, 8];

/** the options the dibur-hamatchil form sends with "only lines that start with [א]" chosen (its essential field) */
const dhFormOptions = () => toEngineOptions("dibur-hamatchil", { ...defaultFormValues("dibur-hamatchil"), lineFilter: "square" }, "essential").options;

async function opened() {
  const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
  await store.openFiles([BASE, COMM]);
  const key = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key;
  return { store, comm: key(COMM_TITLE), base: key(BASE_TITLE) };
}

/** the commentary's line of every suggestion (a dibur-hamatchil record may be written base → commentary) */
function commentaryLines(store: AppStore, comm: string): number[] {
  const sugs = store.suggestions.run.value!.result.suggestions as readonly Suggestion[];
  const line = (s: Suggestion) => (s.source.book.key === comm ? s.source.line : s.target.book.key === comm ? s.target.line : -1);
  return [...new Set(sugs.map(line))].sort((a, b) => a - b);
}

describe("the line filter is the run's: every method of the run obeys it (#40 A1)", () => {
  it("without a filter the fixture links the noise lines too (the case is real)", async () => {
    const { store, comm, base } = await opened();
    const plan = store.maxLink.pairPlan(comm, [base]);
    expect(await store.maxLink.run(plan, "בדיקה")).toBe(true);
    const lines = commentaryLines(store, comm);
    expect(lines).toEqual(expect.arrayContaining([3, 4, 6, 9]));
  });

  it('"every method that fits, merged" with the filter chosen in the dibur-hamatchil form: only lines 2, 5, 8', async () => {
    const { store, comm, base } = await opened();
    // RunForm.start with mergeAll: methods undefined, the form's options under the engine it shows
    const plan = store.maxLink.pairPlan(comm, [base], undefined, undefined);
    expect(new Set(plan.steps.map((s) => s.engine))).toEqual(new Set(["headings", "dibur-hamatchil"]));
    expect(await store.maxLink.run(plan, "בדיקה", { engineOptions: { "dibur-hamatchil": dhFormOptions() } })).toBe(true);
    expect(commentaryLines(store, comm)).toEqual(WANTED);
  });

  it("max-link with the filter in the dibur-hamatchil form: no engine links an excluded line", async () => {
    const { store, comm } = await opened();
    const folder = store.sources.value[0]!;
    const scope = { kind: "source", id: folder.info.id } as const;
    const plan = store.maxLink.plan(scope);
    expect(plan.steps.some((s) => s.engine === "headings")).toBe(true);
    expect(await store.maxLink.run(plan, store.maxLink.scopeLabel(scope), { engineOptions: { "dibur-hamatchil": dhFormOptions() } })).toBe(true);
    expect(commentaryLines(store, comm)).toEqual(WANTED);
  });

  it("the guided flow carries the filter to its run, and keeps it in the saved flow", async () => {
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
    const g = store.guided;
    g.start();
    await g.addBooks([COMM]);
    await g.addBases([BASE]);
    g.setLineFilter({ prefix: { preset: "square" } });
    expect(g.record().lineFilter).toEqual({ prefix: { preset: "square" } });
    expect(await g.run()).toBe(true);
    const comm = [...store.books.value.values()].find((b) => b.title === COMM_TITLE)!.key;
    expect(commentaryLines(store, comm)).toEqual(WANTED);
    // the job keeps the run's filter; the engines' options do not carry it any more
    expect(store.maxLink.job.value!.lineFilter).toEqual({ prefix: { preset: "square" } });
    // a flow continued in a later session has it again; a new flow starts without it
    g.saved.value = g.record();
    g.lineFilter.value = null;
    g.continueSaved();
    expect(g.lineFilter.value).toEqual({ prefix: { preset: "square" } });
    g.start();
    expect(g.lineFilter.value).toBeNull();
    expect(g.setLineFilter({ prefix: { regex: "(a+)+$" } })).toBeTruthy();
    expect(g.lineFilter.value).toBeNull();
  });

  it("the job keeps the filter as the run's, and two different filters in two forms refuse the run", async () => {
    const { store, comm, base } = await opened();
    const plan = store.maxLink.pairPlan(comm, [base]);
    expect(await store.maxLink.run(plan, "בדיקה", { engineOptions: { "dibur-hamatchil": { ...dhFormOptions(), maxDhWords: 8 } } })).toBe(true);
    expect(store.maxLink.job.value!.lineFilter).toEqual({ prefix: { preset: "square" } });
    expect(store.maxLink.job.value!.engineOptions).toEqual({ "dibur-hamatchil": { maxDhWords: 8 } });
    const before = store.suggestions.run.value;
    expect(await store.maxLink.run(plan, "בדיקה", { engineOptions: { "dibur-hamatchil": dhFormOptions(), headings: { sourceFilter: { prefix: { preset: "close-paren" } } } } })).toBe(false);
    expect(store.suggestions.run.value).toBe(before);
    expect(store.notices.value.at(-1)?.text).toMatch(/סינון שורות שונה/);
  });
});

describe("citations obey the line filter too (#40 A1: the form offered it, the worker ignored it)", () => {
  // the real Bereshit of the database slice (tests/fixtures/db): the citations engine resolves against the open books
  const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
  const CITING = text("חיבור.txt", ["<h1>חיבור</h1>", "[א] כמו שנאמר (בראשית א, א) וזה פשוט", "א) ועוד שם (בראשית א, ב) רעש", "[ב] וכן (בראשית א, ג) ודוק", "ב) וראה (בראשית א, ד) רעש"]);
  it("a pair run of the citations engine with the form's filter links only the [א] lines", async () => {
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
    await store.openFiles([DB, CITING]);
    const citing = [...store.books.value.values()].find((b) => b.title === "חיבור")!.key;
    expect(await store.suggestions.runCitations(citing, { noGate: true })).toBe(true);
    expect(commentaryLines(store, citing)).toEqual([1, 2, 3, 4]); // the case is real: every line cites
    const options = toEngineOptions("citations", { ...defaultFormValues("citations"), lineFilter: "square" }, "all").options;
    expect(options["sourceFilter"]).toEqual({ prefix: { preset: "square" } });
    expect(await store.suggestions.runCitations(citing, { ...options, noGate: true })).toBe(true);
    expect(commentaryLines(store, citing)).toEqual([1, 3]);
  });
});
