import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import type { EngineResult } from "../../../src/linking/automatic";
import { pairMethodKey, planMaxLink, type PlanStep, type SingleEngineId } from "../../../src/linking/plan";
import { SourceRegistry } from "../../../src/sources/registry";
import { fingerprintsJob, maxlinkJob, type SingleRunner } from "../../../src/workers/maxlink-job";

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

  it("one call per book (the batch job): the base read by the last call is not read again; every book read has a fingerprint", async () => {
    const { reg, all, byTitle } = await setup();
    const plan = planMaxLink({ selected: [byTitle("ארצות החיים").key], library: all, singleEngines: [] });
    const base = byTitle("ארצות החיים").key;
    const byBook = new Map<string, PlanStep[]>();
    for (const s of plan.steps) byBook.set(s.source.key, [...(byBook.get(s.source.key) ?? []), s]);
    expect(byBook.size).toBe(2);
    const spy = vi.spyOn(reg, "lines");
    const results = [];
    for (const steps of byBook.values()) results.push(await maxlinkJob(reg, steps, {}, {}));
    expect(spy.mock.calls.filter((c) => c[0] === base)).toHaveLength(1);
    for (const [i, steps] of [...byBook.values()].entries()) expect(Object.keys(results[i]!.fingerprints!).sort()).toEqual([steps[0]!.source.key, base].sort());
    // the same text, read again by the fingerprints job: the same fingerprint
    const again = await fingerprintsJob(reg, [base, "s99:ghost"], {});
    expect(again).toEqual({ [base]: results[0]!.fingerprints![base] });
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
    expect(res.dbLinksUnread).toBeUndefined();
  });

  it("a failed read of the database's links is reported with the book, never taken for 'no links' (review C13, M7)", async () => {
    const { reg, all, byTitle } = await setup();
    const onkelos = byTitle("תרגום אונקלוס על בראשית").key;
    const plan = planMaxLink({ selected: [onkelos], library: all, singleEngines: [] });
    vi.spyOn(reg, "existingLinks").mockRejectedValue(Object.assign(new Error("דף פגום במסד"), { code: "db/corrupt" }));
    const res = await maxlinkJob(reg, plan.steps, {}, {});
    expect(res.dbLinksUnread).toEqual([{ key: onkelos, why: "דף פגום במסד" }]);
    expect(res.dbLinkKeys).toEqual([]);
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

  it("cancelled, it stops and returns what it found: the step that ran is kept, marked stopped; the rest do not run", async () => {
    const { reg, all, texts } = await setup();
    const plan = planMaxLink({ selected: texts.map((b) => b.key), library: all, singleEngines: [] });
    expect(plan.steps.length).toBeGreaterThan(1);
    const ac = new AbortController();
    // cancelled during the first step: it ends with what it has, and the next steps do not start
    const res = await maxlinkJob(reg, plan.steps, {}, { signal: ac.signal, progress: (d) => d > 0 && ac.abort() });
    expect(res.stopped).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ stepId: plan.steps[0]!.id, stopped: true });
    // what the engine found until it saw the cancel (an engine that saw it says so: engine/aborted)
    expect(res.items[0]!.result).toBeTruthy();
  });

  it("a step over its time budget (stepBudgetMs) stops with what it found, and the job goes on to the next steps", async () => {
    const { reg, all, byTitle } = await setup();
    const fake = "citations" as unknown as SingleEngineId;
    const plan = planMaxLink({ selected: [byTitle("ספר דוגמה").key], library: all, singleEngines: [fake] });
    expect(plan.steps.length).toBeGreaterThan(1);
    const slow = plan.steps.find((s) => s.kind === "single")!;
    // an engine that runs until it is told to stop (or 1.5 s), polling its signal like the sliced engines do
    const runner: SingleRunner = async (_r, _s, _o, ctx) => {
      const t0 = Date.now();
      while (!ctx.signal?.aborted && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 5));
      return { suggestions: [], notes: ctx.signal?.aborted ? [{ code: "engine/aborted", text: "נעצר" }] : [], unmatched: [] } satisfies EngineResult;
    };
    const res = await maxlinkJob(reg, plan.steps, { stepBudgetMs: 50 }, {}, { citations: runner });
    expect(res.stopped).toBeFalsy();
    expect(res.items.map((i) => i.stepId)).toEqual(plan.steps.map((s) => s.id));
    const it0 = res.items.find((i) => i.stepId === slow.id)!;
    expect(it0).toMatchObject({ stopped: true });
    expect(it0.ms).toBeLessThan(1000);
    expect(res.items.filter((i) => i.stepId !== slow.id).every((i) => !i.stopped && (i.result || i.error))).toBe(true);
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

  it("a place linked to a span of a Sefaria base: a record per line with a ref_2, never a range (sefaria-owned.ts withoutRange)", async () => {
    // the intermediate's line 3 is linked to the base's lines 2–4; the base is a Sefaria book with heRefs
    const heb = ["", "א", "ב", "ג"];
    const withRefs: Record<string, { index: number; text: string; anchorText: string; heading: number | null; heRef: string | null }[]> = {
      ...BOOKS,
      "d:1": BOOKS["d:1"]!.map((l) => (l.heading === null ? { ...l, heRef: `בראשית, א, ${heb[l.index - 1]}` } : l)),
    };
    const spanLinks = [{ id: "s1", source: { book: base, line: 2, end: 4 }, target: { book: mid, line: 3 }, declaredType: "commentary" }, links[1]!];
    const reg = { lines: async (key: string) => withRefs[key]!, existingLinks: async (key: string) => spanLinks.filter((l) => l.source.book.key === key || l.target.book.key === key) } as unknown as SourceRegistry;
    const plan = planMaxLink({ selected: ["d:3"], library, singleEngines: [], engines: new Set(["headings"]) });
    const res = await maxlinkJob(reg, plan.steps, { sefariaOwned: ["d:1"] }, {});
    const one = res.items[1]!.result!.suggestions.find((s) => s.source.line === 3)!;
    expect(one.target.end).toBeUndefined();
    expect(one.citedSpan).toEqual({ line: 2, end: 4 });
    expect(one.spanLines?.map((x) => x.line)).toEqual([2, 3, 4]);
    expect(one.spanLines?.every((x) => x.heRef2.startsWith("בראשית"))).toBe(true);
    expect(one.confidence).not.toBe("certain");
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

  it("a hostile range end on the base side is not expanded line by line: the place is too wide to carry (Issue #41 C1)", async () => {
    // the intermediate's line 3 is linked to the base's lines 4..20,000,000 (a database nobody vouches for); the
    // intermediate side was clipped by scanEnd, the base side was pushed into an array one line at a time (+400 MB)
    const wide = [{ id: "w1", source: { book: base, line: 4, end: 20_000_000 }, target: { book: mid, line: 3 }, declaredType: "commentary" }, links[1]!];
    const reg = { lines: async (key: string) => BOOKS[key]!, existingLinks: async (key: string) => wide.filter((l) => l.source.book.key === key || l.target.book.key === key) } as unknown as SourceRegistry;
    const plan = planMaxLink({ selected: ["d:3"], library, singleEngines: [], engines: new Set(["headings"]) });
    const t0 = performance.now();
    const res = await maxlinkJob(reg, plan.steps, {}, {});
    expect(res.items[1]!.error).toBeUndefined();
    expect(res.items[1]!.result!.suggestions.map((s) => `${s.source.line}>${s.target.line}`)).toEqual(["5>2"]);
    expect(res.items[1]!.result!.notes[0]!.text).toContain("רחב מדי");
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("an intermediate place with no link to the base carries nothing", async () => {
    links.pop();
    const plan = planMaxLink({ selected: ["d:3"], library, singleEngines: [], engines: new Set(["headings"]) });
    const res = await maxlinkJob(registry, plan.steps.filter((s) => s.id === "headings|d:3>d:1"), {}, {}); // the intermediate pair did not run: computed here
    expect(res.items[0]!.result!.suggestions.map((s) => s.target.line)).toEqual([4]);
    expect(res.items[0]!.result!.notes[0]!.text).toContain("אינם מקושרים");
  });
});

describe("maxlinkJob — a part of the dependant against the same part of the base (RelationScope.baseSection)", () => {
  // both books are divided by the same two bases; "שמות א" must never be read against "בראשית א"
  const lines = (texts: string[]) => texts.map((text, index) => ({ index, text, anchorText: text, heading: /^<h(\d)/.exec(text) ? Number(/^<h(\d)/.exec(text)![1]) : null, heRef: null }));
  const BOOKS: Record<string, ReturnType<typeof lines>> = {
    "m:1": lines(["<h1>ביאור</h1>", "<h2>בראשית</h2>", "<h3>פרק א</h3>", "ביאור על בראשית א", "<h2>שמות</h2>", "<h3>פרק א</h3>", "ביאור על שמות א"]),
    "m:2": lines(["<h1>על הביאור</h1>", "<h2>שמות</h2>", "<h3>פרק א</h3>", "הערה על שמות א", "<h2>בראשית</h2>", "<h3>פרק א</h3>", "הערה על בראשית א"]),
  };
  const ref = (key: string, title: string): BookRef => ({ key, title, origin: "sefaria" });
  const registry = { lines: async (key: string) => BOOKS[key]!, existingLinks: async () => [] } as unknown as SourceRegistry;
  const relation = (section: string, baseSection: string) => ({ kind: "commentary" as const, dependant: ref("m:2", "על הביאור"), base: ref("m:1", "ביאור"), via: "links" as const, caveats: [], scope: { section, baseSection } });
  const step = (section: string, baseSection = section): PlanStep => ({ id: `headings|m:2>m:1#${baseSection}`, kind: "pair", engine: "headings", source: ref("m:2", "על הביאור"), target: ref("m:1", "ביאור"), relation: relation(section, baseSection), why: "" });

  it("links each part only into the part of the base with the same name", async () => {
    const res = await maxlinkJob(registry, [step("בראשית"), step("שמות")], {}, {});
    const at = (i: number) => res.items[i]!.result!.suggestions.map((s) => `${s.source.line}>${s.target.line}`);
    expect(at(0)).toEqual(["6>3"]);
    expect(at(1)).toEqual(["3>6"]);
    expect(res.items[0]!.result!.notes[0]!.code).toBe("maxlink/section");
  });

  it("a part missing on either side runs nothing, and says which", async () => {
    const res = await maxlinkJob(registry, [step("ויקרא"), step("בראשית", "ויקרא")], {}, {});
    for (const it of res.items) expect(it.result!.suggestions).toEqual([]);
    expect(res.items[0]!.result!.notes[0]!.text).toContain('"על הביאור"');
    expect(res.items[1]!.result!.notes[0]!.text).toContain('"ביאור"');
  });

  /* #21: the title engine runs only where the titles fit */
  describe("title gate", () => {
    const PLAIN = text("פירוש פשוט על בראשית.txt", ["פירוש פשוט על בראשית", "ביאור ראשון בלי שום כותרת", "ביאור שני בלי שום כותרת", "ביאור שלישי בלי שום כותרת"]);
    async function plain() {
      const reg = new SourceRegistry();
      const res = await reg.open([DB, PLAIN]);
      const all = res.sources.flatMap((s) => s.books);
      return { reg, all, book: all.find((b) => b.title === "פירוש פשוט על בראשית")! };
    }
    const noteCodes = (r: { result?: EngineResult }) => r.result?.notes.map((n) => n.code) ?? [];

    it("a commentary with no titles: the headings step is skipped with the reasons, dibur-hamatchil still runs", async () => {
      const { reg, all, book } = await plain();
      const plan = planMaxLink({ selected: [book.key], library: all, singleEngines: [] });
      const res = await maxlinkJob(reg, plan.steps, {}, {});
      const h = res.items.find((i) => i.stepId.startsWith("headings|"))!;
      expect(h.error).toBeUndefined();
      expect(h.result!.suggestions).toHaveLength(0);
      expect(noteCodes(h)).toContain("title-fit/skipped");
      expect(h.result!.notes.find((n) => n.code === "title-fit/skipped")!.text).toContain("אין כותרות");
      const dh = res.items.find((i) => i.stepId.startsWith("dibur-hamatchil|") && i.stepId.includes(">"))!;
      expect(noteCodes(dh)).not.toContain("title-fit/skipped");
    });

    it("naming headings for the pair forces it: no skip note", async () => {
      const { reg, all, book } = await plain();
      const base = all.find((b) => b.title === "בראשית")!;
      const plan = planMaxLink({ selected: [book.key], library: all, singleEngines: [], choices: { methods: { [pairMethodKey(book.title, base.title)]: ["headings"] } } });
      const res = await maxlinkJob(reg, plan.steps, {}, {});
      expect(noteCodes(res.items[0]!)).not.toContain("title-fit/skipped");
    });

    it("titles that fit: the headings step runs as before", async () => {
      const { reg, all, byTitle } = await setup();
      const plan = planMaxLink({ selected: [byTitle("ביאור על בראשית").key], library: all, singleEngines: [] });
      const res = await maxlinkJob(reg, plan.steps, {}, {});
      const h = res.items.find((i) => i.stepId.startsWith("headings|"))!;
      expect(noteCodes(h)).not.toContain("title-fit/skipped");
      expect(h.result!.suggestions.filter((x) => x.confidence === "certain")).toHaveLength(10);
    });
  });
});
