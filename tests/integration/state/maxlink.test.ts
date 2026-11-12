import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import type { EngineId } from "../../../src/linking/automatic";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import type { MergedSuggestion } from "../../../src/linking/merge";
import { registryService } from "../../support/books-service";

/*
 * Max-link through the store, on the real database slice plus a "folder" of text files: plan,
 * run, one merged suggestions run, approve the certain ones, undo, and the live report.
 */
function makeStore() {
  const reg = new SourceRegistry();
  const service = registryService(reg);
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(service, { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  return { store, saved };
}
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "יא", "יב", "יג", "יד", "טו", "טז", "יז", "יח", "יט", "כ"][n]!;
const text = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const FOLDER = [
  text("ביאור על בראשית.txt", ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 20 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat()]),
  text("ספר דוגמה.txt", ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה עם הערה (1) ועוד אחת (2).", "<h2>פרק ב</h2>", "כאן המספור מתחיל שוב (1)."]),
  text("הערות לספר דוגמה.txt", ["<h1>הערות לספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה בפרק א.", "(2) הערה שנייה בפרק א.", "<h2>פרק ב</h2>", "(1) הערה ראשונה בפרק ב."]),
  text("חידושים.txt", ["שורה"]),
];

async function opened() {
  const { store, saved } = makeStore();
  await store.openFiles([DB]);
  await store.openFiles(FOLDER);
  const folder = store.sources.value.find((s) => s.info.kind === "text-files")!;
  const key = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key;
  return { store, saved, folder, key };
}

/** the pair engines: these cases count their steps; the citations engine (single-book) is checked in maxlink-job.test.ts */
const PAIRS: ReadonlySet<EngineId> = new Set(["headings", "dibur-hamatchil", "footnotes"]);

describe("AppStore — max-link", () => {
  it("plans a folder: each book with the engines that fit it and why; books it cannot link, with the reason", async () => {
    const { store, folder } = await opened();
    const plan = store.maxLink.plan({ kind: "source", id: folder.info.id }, PAIRS);
    expect(plan.books).toHaveLength(4);
    expect(plan.perEngine).toEqual({ headings: 1, "dibur-hamatchil": 2, footnotes: 1 }); // DH twice: the base, and רש"י on it (plan.ts intermediateSteps)
    expect(plan.books.find((b) => b.book.title === "חידושים")!.skipped).toBeTruthy();
    expect(plan.identified).toBe(3);
  });

  it("runs into ONE suggestions run; approve all certain is one undoable action; the report follows", async () => {
    const { store, folder, saved } = await opened();
    const scope = { kind: "source", id: folder.info.id } as const;
    expect(await store.maxLink.run(store.maxLink.plan(scope, PAIRS), store.maxLink.scopeLabel(scope))).toBe(true);
    const run = store.suggestions.run.value!;
    expect(run.maxlink!.steps).toHaveLength(4);
    const sugs = run.result.suggestions as MergedSuggestion[];
    // footnotes: 3 markers; the commentary: one per verse (headings and dibur-hamatchil agree or stand alone)
    expect(sugs.filter((s) => s.engines.includes("footnotes"))).toHaveLength(3);
    expect(sugs.filter((s) => s.focus === store.books.value.get(sugs.find((x) => x.engines.includes("headings"))!.focus)!.key).length).toBe(20);
    const rep = store.maxLink.report.value!;
    expect(rep.overall).toMatchObject({ booksChecked: 4, booksIdentified: 3, steps: 4, links: 23, errors: 0 });

    const certain = store.suggestions.pendingAtLeast("certain");
    expect(certain.length).toBe(rep.overall.certain);
    expect(sugs.filter((s) => certain.includes(s.id)).every((s) => s.confidence === "certain")).toBe(true);
    expect(store.suggestions.approve(certain)).toBe(certain.length);
    expect(store.maxLink.report.value!.overall.approved).toBe(certain.length);
    expect(store.allLinks.value).toHaveLength(certain.length);
    store.undo();
    expect(store.allLinks.value).toHaveLength(0);
    expect(store.maxLink.report.value!.overall.approved).toBe(0);
    expect(store.suggestions.counts.value.pending).toBe(23);

    store.maxLink.saveReport();
    expect(saved.at(-1)!.name).toMatch(/^קישור-מרבי-.*\.csv$/);
    expect(String(saved.at(-1)!.data)).toContain("ביאור על בראשית");
  });

  it("suggestions the database already has show as 'already exists' (Onkelos on Bereshit)", async () => {
    const { store, key } = await opened();
    const scope = { kind: "book", key: key("תרגום אונקלוס על בראשית") } as const;
    const plan = store.maxLink.plan(scope, PAIRS);
    expect(plan.steps.map((s) => s.engine)).toEqual(["headings"]); // a targum: no dibur-hamatchil
    await store.maxLink.run(plan, "אונקלוס");
    const rep = store.maxLink.report.value!;
    expect(rep.overall.existing).toBeGreaterThan(100);
    expect(rep.overall.existing / rep.overall.links).toBeGreaterThan(0.9);
    expect(store.suggestions.run.value!.result.suggestions.filter((s) => s.rules.includes("maxlink/exists-db")).length).toBe(rep.overall.existing);
  });

  it("a rejection survives a re-run, and a link approved in a single-engine run is 'already exists' here", async () => {
    const { store, folder, key } = await opened();
    const scope = { kind: "source", id: folder.info.id } as const;
    await store.suggestions.runEngine("headings", key("ביאור על בראשית"), key("בראשית"));
    const firstHeadings = store.suggestions.pendingAtLeast("certain")[0]!;
    expect(store.suggestions.approve([firstHeadings])).toBe(1);

    await store.maxLink.run(store.maxLink.plan(scope, PAIRS), "תיקייה");
    expect(store.suggestions.counts.value.exists).toBe(1); // not approvable a second time
    const pending = new Set(store.suggestions.pendingAtLeast("certain"));
    const sugs = store.suggestions.run.value!.result.suggestions as MergedSuggestion[];
    // one that both engines agreed on and whose record is dibur-hamatchil's: the re-run below has only headings
    const victim = sugs.find((s) => pending.has(s.id) && s.engines.length === 2 && s.engine === "dibur-hamatchil")?.id ?? sugs.find((s) => pending.has(s.id) && s.engines.includes("headings"))!.id;
    store.suggestions.reject([victim]);
    await store.maxLink.run(store.maxLink.plan(scope, new Set(["headings"])), "תיקייה, רק כותרות");
    expect(store.suggestions.counts.value.rejected).toBe(1);
    expect(store.suggestions.run.value!.result.suggestions.find((s) => s.id === victim)).toBeTruthy(); // the same id without dibur-hamatchil
  });
});
