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

  // V7 PR2 review, finding 2: an excluded line is not linked, but it is still read: "שם" on the next included line refers to the
  // place the excluded line cited (the reader reads it), not to the last place on an included line
  it('"שם" after a citation on an excluded line: the excluded line is the antecedent, and is not linked', async () => {
    const IBID = text("חיבור.txt", ["<h1>חיבור</h1>", "[א] כמו שנאמר (בראשית א, א) וזה פשוט", "א) ועוד שם (בראשית ב, ב) רעש", "[ב] וכן (שם, ג) ודוק"]);
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
    await store.openFiles([DB, IBID]);
    const citing = [...store.books.value.values()].find((b) => b.title === "חיבור")!.key;
    const placeOf = (line: number) => {
      const s = (store.suggestions.run.value!.result.suggestions as readonly Suggestion[]).find((x) => x.source.book.key === citing && x.source.line === line)!;
      return { heRef: s.heRef2, confidence: s.confidence };
    };
    expect(await store.suggestions.runCitations(citing, { noGate: true })).toBe(true);
    const unfiltered = placeOf(3);
    expect(unfiltered.heRef).toMatch(/ב, ג/);
    expect(await store.suggestions.runCitations(citing, { noGate: true, sourceFilter: { prefix: { preset: "square" } } })).toBe(true);
    expect(commentaryLines(store, citing)).toEqual([1, 3]);
    expect(placeOf(3)).toEqual(unfiltered);
  });
});

describe("max-link footnotes steps judge the run's filter on the NOTES book, the dependent side (V7 PR2 review, finding 4)", () => {
  // the plan writes a footnotes step base → notes (the markers are in the base); the run's filter is a statement about the dependent
  // books, so on such a step it is the notes book's lines that may or may not carry a link — never the base's
  const BASE_FN = (first: string) =>
    text(`${BASE_TITLE}.txt`, [`<h1>${BASE_TITLE}</h1>`, "<h2>פרק א</h2>", `${first}אלפא בטא<sup>1</sup> גמא דלתא הא וו זין`, "כף למד מם<sup>2</sup> נון סמך עין", "<h2>פרק ב</h2>", "שין תיו אלף<sup>3</sup> בית גימל"]);
  const NOTES_TITLE = "הערות על ספר בסיס";
  const NOTES_FN = text(`${NOTES_TITLE}.txt`, [`<h1>${NOTES_TITLE}</h1>`, "<h2>פרק א</h2>", "<sup>1</sup> הערה אחת", "<sup>2</sup> הערה שתיים", "<h2>פרק ב</h2>", "<sup>3</sup> הערה שלוש"]);
  async function maxLink(first: string, lineFilter?: { prefix: { preset: "square" }; mode?: "exclude" }) {
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
    await store.openFiles([BASE_FN(first), NOTES_FN]);
    const scope = { kind: "source", id: store.sources.value[0]!.info.id } as const;
    const plan = store.maxLink.plan(scope);
    expect(plan.steps.some((s) => s.engine === "footnotes")).toBe(true);
    const shown = await store.maxLink.run(plan, store.maxLink.scopeLabel(scope), lineFilter ? { lineFilter } : {});
    const all = shown ? (store.suggestions.run.value!.result.suggestions as readonly Suggestion[]) : [];
    const notes = shown ? store.suggestions.run.value!.result.notes.map((n) => n.code) : [];
    return { footnotes: all.filter((s) => s.engine === "footnotes").map((s) => `${s.source.line}>${s.target.line}`), byHeadings: notes.includes("maxlink/notes-by-headings"), all };
  }

  it("without a filter: three notes (the case is real)", async () => {
    expect((await maxLink("")).footnotes).toEqual(["2>2", "3>3", "5>5"]);
  });

  it('"skip the lines that start with [א]": a base line that starts with [א] keeps its note — the notes book has no such line', async () => {
    expect((await maxLink("[א] ", { prefix: { preset: "square" }, mode: "exclude" })).footnotes).toEqual(["2>2", "3>3", "5>5"]);
  });

  it('"only lines that start with [א]" (meant for commentaries): no note line carries it, so no note is linked — and the notes are not linked by headings instead', async () => {
    const r = await maxLink("[א] ", { prefix: { preset: "square" } });
    expect(r.footnotes).toEqual([]);
    expect(r.byHeadings).toBe(false);
    expect(r.all.filter((s) => s.engine === "headings")).toEqual([]);
  });
});

describe("dibur-hamatchil under the line filter: a בא\"ד or שם line inherits from the last INCLUDED line (V7 PR2 review, finding 2)", () => {
  // the excluded lines are another commentary interleaved in the book (issue #27): a "בא"ד" of the [א] commentary continues its own
  // previous dibur, never the excluded line between them. Words engines see an excluded line empty, and an empty line neither links
  // nor breaks the chain; the guard drops nothing here because nothing is proposed on an excluded line.
  const DH_COMM = text(`${COMM_TITLE}.txt`, [
    `<h1>${COMM_TITLE}</h1>`,
    "<h2>פרק א</h2>",
    "[א] אלפא בטא גמא: פירוש על הדברים האלה כאן",
    "א) כף למד מם נון: שורת רעש שאינה צריכה להיכנס",
    "[ב] בא\"ד והוא המשך הפירוש",
  ]);
  it("the בא\"ד line follows line 2 (base line 2), not the excluded line 3 (base line 3)", async () => {
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
    await store.openFiles([BASE, DH_COMM]);
    const key = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key;
    const comm = key(COMM_TITLE);
    const baseLineOf = (line: number) => {
      const s = (store.suggestions.run.value!.result.suggestions as readonly Suggestion[]).find((x) => (x.source.book.key === comm ? x.source.line : x.target.line) === line && (x.source.book.key === comm || x.target.book.key === comm));
      return s ? (s.source.book.key === comm ? s.target.line : s.source.line) : null;
    };
    expect(await store.suggestions.runEngine("dibur-hamatchil", comm, key(BASE_TITLE), { sourceFilter: { prefix: { preset: "square" } } })).toBe(true);
    expect(commentaryLines(store, comm)).toEqual([2, 4]);
    expect(baseLineOf(4)).toBe(baseLineOf(2));
    expect(baseLineOf(2)).toBe(2);
    const inherited = (store.suggestions.run.value!.result.suggestions as readonly Suggestion[]).find((x) => x.target.book.key === comm && x.target.line === 4)!;
    expect(inherited.rules).toContain("dh/inherit-baad");
  });
});
