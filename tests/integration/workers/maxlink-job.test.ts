import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import type { EngineResult } from "../../../src/linking/automatic";
import { planMaxLink, type PlanStep, type SingleEngineId } from "../../../src/linking/plan";
import { SourceRegistry } from "../../../src/sources/registry";
import { maxlinkJob, type SingleRunner } from "../../../src/workers/maxlink-job";

/*
 * The max-link job over the real database slice (tests/fixtures/db/seforim-v7-mini.db) plus text
 * files: steps run in order with progress, a pair is read once for all its engines, a failing step
 * does not stop the others, single-book engines run through their registered runner.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"][n]!;
const text = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const BIUR = text("ביאור על בראשית.txt", ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat()]);
const MAIN = text("ספר דוגמה.txt", ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה עם הערה (1) ועוד אחת (2).", "<h2>פרק ב</h2>", "כאן המספור מתחיל שוב (1)."]);
const NOTES = text("הערות לספר דוגמה.txt", ["<h1>הערות לספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה בפרק א.", "(2) הערה שנייה בפרק א.", "<h2>פרק ב</h2>", "(1) הערה ראשונה בפרק ב."]);

async function setup() {
  const reg = new SourceRegistry();
  const res = await reg.open([DB, BIUR, MAIN, NOTES]);
  const all = res.sources.flatMap((s) => s.books);
  const texts = res.sources.find((s) => s.info.kind === "text-files")!.books;
  const byTitle = (t: string) => all.find((b) => b.title === t)!;
  return { reg, all, texts, byTitle };
}

// these cases are about the pair engines; the citations step (single-book) has its own case below
describe("maxlinkJob", () => {
  it("runs every planned step and returns one result per step, in the plan's order", async () => {
    const { reg, all, texts } = await setup();
    const plan = planMaxLink({ selected: texts.map((b) => b.key), library: all, singleEngines: [] });
    // the last step: the commentary against רש"י on the same base, for lines that quote רש"י (plan.ts intermediateSteps)
    expect(plan.steps.map((s) => s.engine)).toEqual(["headings", "dibur-hamatchil", "footnotes", "dibur-hamatchil"]);
    const progress: [number, number][] = [];
    const res = await maxlinkJob(reg, plan.steps, {}, { progress: (d, n) => progress.push([d, n]) });
    expect(res.items.map((i) => i.stepId)).toEqual(plan.steps.map((s) => s.id));
    expect(res.items.every((i) => !i.error)).toBe(true);
    expect(res.items[0]!.result!.suggestions.filter((s) => s.confidence === "certain")).toHaveLength(10);
    expect(res.items[2]!.result!.suggestions).toHaveLength(3);
    expect(res.items[0]!.result!.unmatched).toEqual([]); // only the count crosses the worker
    // progress: never backwards, and it ends at the total
    for (let i = 1; i < progress.length; i++) expect(progress[i]![0]).toBeGreaterThanOrEqual(progress[i - 1]![0]);
    expect(progress.at(-1)![0]).toBe(progress.at(-1)![1]);
  });

  it("reads a pair once for all of its engines (one pair in memory at a time)", async () => {
    const { reg, all, byTitle } = await setup();
    const plan = planMaxLink({ selected: [byTitle("ביאור על בראשית").key], library: all, singleEngines: [] });
    const spy = vi.spyOn(reg, "lines");
    await maxlinkJob(reg, plan.steps, {}, {});
    expect(plan.steps).toHaveLength(3); // headings + DH against the base, DH against רש"י on it
    expect(spy).toHaveBeenCalledTimes(3); // the commentary, its base and רש"י — each once
  });

  it("commentaries on one base read the base once: it is kept from one pair to the next", async () => {
    const { reg, all, byTitle } = await setup();
    const plan = planMaxLink({ selected: [byTitle("ארצות החיים").key], library: all, singleEngines: [] });
    expect(plan.steps.filter((s) => s.kind === "pair" && s.target.title === "ארצות החיים")).toHaveLength(4); // two commentaries, two engines
    const spy = vi.spyOn(reg, "lines");
    const res = await maxlinkJob(reg, plan.steps, {}, {});
    expect(spy.mock.calls.map((c) => c[0]).filter((k) => k === byTitle("ארצות החיים").key)).toHaveLength(1);
    expect(res.items.map((i) => i.stepId)).toEqual(plan.steps.map((s) => s.id)); // still reported in the plan's order
  });

  it("a failing step is reported and the rest still run", async () => {
    const { reg, all, texts } = await setup();
    const plan = planMaxLink({ selected: texts.map((b) => b.key), library: all, singleEngines: [] });
    const ghost: BookRef = { key: "s99:1", title: "ספר שנסגר", origin: "otzaria" };
    const bad: PlanStep = { ...(plan.steps[0] as Extract<PlanStep, { kind: "pair" }>), id: "headings|ghost", source: ghost };
    const res = await maxlinkJob(reg, [bad, ...plan.steps], {}, {});
    expect(res.items[0]!.error).toBeTruthy();
    expect(res.items.slice(1).every((i) => i.result && !i.error)).toBe(true);
  });

  it("collects the database's links of the books it read from, for 'already exists'", async () => {
    const { reg, all, byTitle } = await setup();
    const plan = planMaxLink({ selected: [byTitle("תרגום אונקלוס על בראשית").key], library: all, singleEngines: [] });
    const res = await maxlinkJob(reg, plan.steps, {}, {});
    expect(res.dbLinkKeys.length).toBeGreaterThan(100);
  });

  it("single-book engines run through their registered runner; one without a runner fails alone", async () => {
    const { reg, all, byTitle } = await setup();
    const fake = "citations" as unknown as SingleEngineId;
    const plan = planMaxLink({ selected: [byTitle("ספר דוגמה").key], library: all, singleEngines: [fake] });
    const single = plan.steps.filter((s) => s.kind === "single");
    expect(single).toHaveLength(1);
    const seen: string[] = [];
    const runner: SingleRunner = async (registry, source, _o, ctx) => {
      const lines = await registry.lines(source.key, 0, 10);
      seen.push(`${source.title}:${lines.length}`);
      ctx.progress?.(1, 2);
      return { suggestions: [], notes: [{ code: "citations/fake", text: "רץ" }], unmatched: [] } satisfies EngineResult;
    };
    const ok = await maxlinkJob(reg, plan.steps, {}, {}, { citations: runner });
    expect(seen).toEqual(["ספר דוגמה:5"]);
    expect(ok.items.find((i) => i.stepId === single[0]!.id)!.result!.notes[0]!.code).toBe("citations/fake");
    const missing = await maxlinkJob(reg, plan.steps, {}, {}, {});
    expect(missing.items.find((i) => i.stepId === single[0]!.id)!.error).toContain("citations");
    expect(missing.items.filter((i) => i.result).length).toBe(plan.steps.length - 1);
  });

  it("stops when cancelled", async () => {
    const { reg, all, texts } = await setup();
    const plan = planMaxLink({ selected: texts.map((b) => b.key), library: all, singleEngines: [] });
    const ac = new AbortController();
    const run = maxlinkJob(reg, plan.steps, {}, { signal: ac.signal, progress: () => ac.abort() });
    await expect(run).rejects.toThrow();
  });
});

describe("maxlinkJob — notes on a main book with no note marks (Sefaria's notes on מכילתא דרשב\"י)", () => {
  it("when the footnotes engine finds nothing, the notes are linked by headings, as a commentary", async () => {
    const main = text("ספר בלי סימנים.txt", ["<h1>ספר בלי סימנים</h1>", "<h2>פרק א</h2>", "(א) שורה ראשונה של הפרק", "(ב) שורה שנייה של הפרק", "<h2>פרק ב</h2>", "(א) שורה אחרת"]);
    const notes = text("הערות לספר בלי סימנים.txt", ["<h1>הערות לספר בלי סימנים</h1>", "<h2>פרק א</h2>", "<h3>פסוק ב</h3>", "הערה על השורה השנייה בלי מספר", "<h2>פרק ב</h2>", "<h3>פסוק א</h3>", "הערה אחרת"]);
    const reg = new SourceRegistry();
    const books = (await reg.open([main, notes])).sources.flatMap((s) => s.books);
    const plan = planMaxLink({ selected: [books.find((b) => b.title.startsWith("הערות"))!.key], library: books, singleEngines: [] });
    expect(plan.steps.map((s) => s.engine)).toEqual(["footnotes"]);
    const res = await maxlinkJob(reg, plan.steps, {}, {});
    const r = res.items[0]!.result!;
    expect(r.notes[0]!.code).toBe("maxlink/notes-by-headings");
    // the note under "פרק א › פסוק ב" → the main book's line "(ב)" of פרק א
    expect(r.suggestions.map((x) => [x.engine, x.source.line, x.target.line])).toContainEqual(["headings", 3, 3]);
  });

  it("the headings fallback gets the library's Sefaria answer: no range on a Sefaria main book (audit F1)", async () => {
    const main = text("ספר בלי סימנים.txt", ["<h1>ספר בלי סימנים</h1>", "<h2>פרק א</h2>", "(א) שורה ראשונה של הפרק", "(ב) שורה שנייה של הפרק"]);
    // a note on the chapter as a whole: by headings it links to the chapter's lines, a range
    const notes = text("הערות לספר בלי סימנים.txt", ["<h1>הערות לספר בלי סימנים</h1>", "<h2>פרק א</h2>", "הערה על כל הפרק"]);
    const reg = new SourceRegistry();
    const books = (await reg.open([main, notes])).sources.flatMap((s) => s.books);
    const mainKey = books.find((b) => !b.title.startsWith("הערות"))!.key;
    const plan = planMaxLink({ selected: [books.find((b) => b.title.startsWith("הערות"))!.key], library: books, singleEngines: [] });
    const targetOf = async (sefariaOwned?: string[]) => {
      const r = (await maxlinkJob(reg, plan.steps, sefariaOwned ? { sefariaOwned } : {}, {})).items[0]!.result!;
      expect(r.notes[0]!.code).toBe("maxlink/notes-by-headings");
      return r.suggestions.find((x) => x.engine === "headings" && x.source.line === 2)!.target;
    };
    expect(await targetOf()).toMatchObject({ line: 2, end: 3 });
    expect((await targetOf([mainKey])).end).toBeUndefined();
  });
});

describe("maxlinkJob — the citations engine (single-book)", () => {
  it("runs once on the selected book, through its registered runner", async () => {
    const { reg, all, byTitle } = await setup();
    const plan = planMaxLink({ selected: [byTitle("ביאור על בראשית").key], library: all });
    expect(plan.steps.map((s) => s.engine)).toEqual(["headings", "dibur-hamatchil", "dibur-hamatchil", "citations"]); // the second DH: against רש"י on the base
    const res = await maxlinkJob(reg, plan.steps, {}, {});
    const cit = res.items.find((i) => i.stepId.startsWith("citations|"))!;
    expect(cit.error).toBeUndefined();
    expect(cit.result!.notes.some((n) => n.code === "citations/summary")).toBe(true);
  });
});

describe("maxlinkJob — a commentary on a commentary, carried to the base of its base (plan.ts RelationThrough)", () => {
  // the dependant follows the intermediate's numbering (its "סעיף ב" is the intermediate's ס"ק ב); the base
  // is numbered otherwise, and only the source's links between the intermediate and the base tell where
  const lines = (texts: string[]) => texts.map((text, index) => ({ index, text, anchorText: text, heading: /^<h(\d)/.exec(text) ? Number(/^<h(\d)/.exec(text)![1]) : null, heRef: null }));
  const BOOKS: Record<string, ReturnType<typeof lines>> = {
    "d:1": lines(["<h1>בסיס</h1>", "<h2>סימן א</h2>", "סעיף ראשון של הבסיס", "סעיף שני של הבסיס", "סעיף שלישי של הבסיס"]),
    "d:2": lines(["<h1>ביניים</h1>", "<h2>סימן א</h2>", "<h3>סעיף א</h3>", "ביאור ראשון", "<h3>סעיף ב</h3>", "ביאור שני"]),
    "d:3": lines(["<h1>על הביניים</h1>", "<h2>סימן א</h2>", "<h3>סעיף א</h3>", "הערה על הביאור הראשון", "<h3>סעיף ב</h3>", "הערה על הביאור השני"]),
  };
  const ref = (key: string, title: string): BookRef => ({ key, title, origin: "sefaria" });
  const base = ref("d:1", "בסיס");
  const mid = ref("d:2", "ביניים");
  const dep = ref("d:3", "על הביניים");
  // the intermediate's lines 3 and 5 are linked to the base's lines 4 and 2 (crossing: not the same numbering)
  const links = [
    { id: "l1", source: { book: base, line: 4 }, target: { book: mid, line: 3 }, declaredType: "commentary" },
    { id: "l2", source: { book: base, line: 2 }, target: { book: mid, line: 5 }, declaredType: "commentary" },
  ];
  const registry = {
    lines: async (key: string) => BOOKS[key]!,
    existingLinks: async (key: string) => links.filter((l) => l.source.book.key === key || l.target.book.key === key),
  } as unknown as SourceRegistry;
  const library = [
    { ...base, isBaseBook: true },
    { ...mid, bases: ["d:1"] },
    { ...dep, bases: ["d:1", "d:2"] },
  ];

  it("links each line where its place in the intermediate is linked, and says how", async () => {
    const plan = planMaxLink({ selected: ["d:3"], library, singleEngines: [], engines: new Set(["headings"]) });
    expect(plan.steps.map((s) => s.id)).toEqual(["headings|d:3>d:2", "headings|d:3>d:1"]);
    const res = await maxlinkJob(registry, plan.steps, {}, {});
    const toMid = res.items[0]!.result!.suggestions.map((s) => `${s.source.line}>${s.target.line}`);
    expect(toMid).toEqual(["3>3", "5>5"]);
    const through = res.items[1]!.result!;
    expect(through.suggestions.map((s) => `${s.source.line}>${s.target.book.key}#${s.target.line}`)).toEqual(["3>d:1#4", "5>d:1#2"]);
    expect(through.suggestions.every((s) => s.rules.includes("maxlink/through") && s.declaredType === "source")).toBe(true);
    expect(through.notes[0]!.text).toContain("דרך");
  });

  it("a citation inside the intermediate (REFERENCE, LINKER) is not where its line stands on the base", async () => {
    const far: Record<string, ReturnType<typeof lines>> = { ...BOOKS, "d:1": lines(["<h1>בסיס</h1>", "<h2>סימן א</h2>", "סעיף ראשון", "סעיף שני", "סעיף שלישי", "שורה", "שורה", "שורה", "שורה", "סימן אחר"]) };
    const cited = [...links, { id: "l3", source: { book: mid, line: 3 }, target: { book: base, line: 9 }, declaredType: "reference" }];
    const reg = { lines: async (key: string) => far[key]!, existingLinks: async (key: string) => cited.filter((l) => l.source.book.key === key || l.target.book.key === key) } as unknown as SourceRegistry;
    const plan = planMaxLink({ selected: ["d:3"], library, singleEngines: [], engines: new Set(["headings"]) });
    const res = await maxlinkJob(reg, plan.steps, {}, {});
    // line 3 is still carried to the base's line 4 (its COMMENTARY link), not dropped as spread over 4..9
    expect(res.items[1]!.result!.suggestions.map((s) => `${s.source.line}>${s.target.line}`)).toEqual(["3>4", "5>2"]);
  });

  it("an intermediate place with no link to the base carries nothing", async () => {
    links.pop();
    const plan = planMaxLink({ selected: ["d:3"], library, singleEngines: [], engines: new Set(["headings"]) });
    const res = await maxlinkJob(registry, plan.steps.filter((s) => s.id === "headings|d:3>d:1"), {}, {}); // the intermediate pair did not run: computed here
    expect(res.items[0]!.result!.suggestions.map((s) => s.target.line)).toEqual([4]);
    expect(res.items[0]!.result!.notes[0]!.text).toContain("אינם מקושרים");
  });
});
