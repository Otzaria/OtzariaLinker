import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { GUIDED_KEY, parseGuidedRecord } from "../../../src/state/guided-flow";
import { loadPreferences } from "../../../src/state/preferences";
import type { KeyValueStore } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * The guided flow through the store, on the real database slice and "folders" of text files: the
 * database asked only when a base is missing, the base chosen when it is open twice, the export's
 * book rules said before the run, run → approve → check → download, and a flow continued after a reload.
 */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"][n]!;
const text = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const commentary = (title: string) => text(`${title}.txt`, [`<h1>${title}</h1>`, "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat()]);
const bereshit = text("בראשית.txt", ["<h1>בראשית</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => `פסוק ${i + 1} של הספר.`)]);

function memoryKv(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k) };
}
function makeStore() {
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(registryService(new SourceRegistry()), { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  return { store, saved };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("guided flow — the method per book pair (#21)", () => {
  async function ready() {
    const { store } = makeStore();
    const g = store.guided;
    g.start();
    await g.addBooks([commentary("ביאור א על בראשית"), commentary("ביאור ב על בראשית")]);
    await g.addBases([DB]);
    return { store, g };
  }
  const engines = (g: Awaited<ReturnType<typeof ready>>["g"]) => g.plan.value!.steps.filter((x) => x.kind === "pair").map((x) => `${x.engine}:${x.source.title}`);

  it("by default every method that fits runs (the title gate decides at run time)", async () => {
    const { g } = await ready();
    expect(g.plan.value!.perEngine).toMatchObject({ headings: 2, "dibur-hamatchil": 4 });
    expect(g.methods.value).toBeNull();
  });

  it("force dibur-hamatchil for all pairs: no headings step in the plan, and the run keeps it that way", async () => {
    const { g, store } = await ready();
    g.setMethods(new Set(["dibur-hamatchil"]));
    expect(g.plan.value!.perEngine.headings).toBeUndefined();
    expect(g.plan.value!.perEngine["dibur-hamatchil"]).toBeGreaterThan(0);
    expect(await g.run()).toBe(true);
    // forcing dibur-hamatchil replaces ONLY the headings engine: the single-book engine (citations) still runs on those books
    expect(g.plan.value!.perEngine.citations).toBeGreaterThan(0);
    expect([...store.maxLink.job.value!.engines!].sort()).toEqual(["citations", "dibur-hamatchil"]);
  });

  it("forcing dibur-hamatchil leaves the footnotes step of the notes books alone (owner decision)", async () => {
    const { store } = makeStore();
    const g = store.guided;
    g.start();
    await g.addBooks([text("ספר דוגמה.txt", ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה עם הערה (1) ועוד."]), text("הערות לספר דוגמה.txt", ["<h1>הערות לספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה."]), commentary("ביאור על בראשית")]);
    await g.addBases([DB]);
    expect(g.plan.value!.perEngine.footnotes).toBe(1);
    g.setMethods(new Set(["dibur-hamatchil"]));
    expect(g.plan.value!.perEngine.footnotes).toBe(1);
    expect(g.plan.value!.perEngine.headings).toBeUndefined();
  });

  it("the method choice is kept in the saved flow and comes back when it is continued", async () => {
    const { g } = await ready();
    g.setMethods(new Set(["dibur-hamatchil"]));
    g.setPairMethods("ביאור א על בראשית", "בראשית", ["headings"]);
    const rec = g.record();
    expect(rec.methods).toEqual(["dibur-hamatchil"]);
    expect(rec.pairMethods).toEqual({ "ביאור א על בראשית>בראשית": ["headings"] });
    const again = parseGuidedRecord(JSON.stringify(rec))!;
    expect(again.methods).toEqual(["dibur-hamatchil"]);
    // an older record, saved before the choice was kept, loads with none
    const { methods: _m, pairMethods: _p, ...old } = rec;
    expect(parseGuidedRecord(JSON.stringify(old))).toMatchObject({ step: rec.step });
    expect(parseGuidedRecord(JSON.stringify(old))!.methods).toBeUndefined();
    g.setMethods(null);
    g.setPairMethods("ביאור א על בראשית", "בראשית", null);
    g.saved.value = again;
    g.continueSaved();
    expect([...g.methods.value!]).toEqual(["dibur-hamatchil"]);
    expect(g.pairMethods.value).toEqual({ "ביאור א על בראשית>בראשית": ["headings"] });
  });

  it("one pair on its own method, the other on the default", async () => {
    const { g } = await ready();
    g.setPairMethods("ביאור א על בראשית", "בראשית", ["headings"]);
    expect(engines(g).filter((e) => e.includes("ביאור א"))).toEqual(["headings:ביאור א על בראשית"]);
    expect(engines(g).filter((e) => e.includes("ביאור ב"))).toContain("dibur-hamatchil:ביאור ב על בראשית");
    g.setPairMethods("ביאור א על בראשית", "בראשית", null);
    expect(engines(g).filter((e) => e.includes("ביאור א"))).toContain("dibur-hamatchil:ביאור א על בראשית");
    expect(g.pairMethods.value).toEqual({});
  });
});

describe("guided flow — through the store", () => {
  it("a folder of commentaries: the database is asked for, named; then plan → run → approve → check → download", async () => {
    const { store, saved } = makeStore();
    const g = store.guided;
    g.start();
    expect([store.screen.value, g.step.value]).toEqual(["guided", "files"]);
    expect(await g.addBooks([commentary("ביאור א על בראשית"), commentary("ביאור ב על בראשית")])).toBe(1);
    expect(store.screen.value).toBe("guided"); // opening books does not leave the flow
    expect(g.missing.value).toEqual([{ title: "בראשית", books: ["ביאור א על בראשית", "ביאור ב על בראשית"] }]);
    g.next();
    expect(g.step.value).toBe("books");
    g.next();
    expect(g.step.value).toBe("db");

    await g.addBases([DB]);
    expect(g.missing.value).toEqual([]);
    expect(g.groups.value[0]!.text).toBe('2 פירושים על "בראשית"');
    expect(g.plan.value!.books).toHaveLength(2); // the database's books are bases, not selected
    g.next();
    expect(g.step.value).toBe("plan");
    expect(g.preflight.value).toEqual([]);

    expect(await g.run()).toBe(true);
    expect([g.step.value, g.ran.value]).toEqual(["run", true]);
    const certain = store.maxLink.report.value!.overall.certain;
    expect(certain).toBeGreaterThan(0);
    expect(g.approveCertain()).toBe(certain);
    g.next();
    expect(g.step.value).toBe("finish");

    await g.check();
    expect(g.stale.value).toBe(false);
    expect(g.bundle.value!.files.length).toBe(2);
    expect(store.quality.report.value!.bySeverity.error).toBe(0);
    expect(g.download()).toBe(true);
    expect(saved.at(-1)!.name).toMatch(/\.zip$/);
    expect(g.downloaded.value).toMatch(/ZIP/);
  });

  it("the user's own 'בראשית' next to the database's: the base is chosen, and the export's rule is said before the run", async () => {
    const { store } = makeStore();
    const g = store.guided;
    g.start();
    await g.addBooks([bereshit, commentary("ביאור חדש על בראשית")]);
    expect(g.facts.value).toMatchObject({ books: 2, missingBases: 0, baseChoices: 0 });
    g.next();
    g.next();
    expect(g.step.value).toBe("plan"); // every base is in the folder: no database step

    // the database opened anyway (from the workspace, or a later step): "בראשית" is open twice
    await store.openFiles([DB]);
    expect(store.screen.value).toBe("guided");
    expect(g.facts.value.baseChoices).toBe(1);
    expect(g.plan.value!.baseSources[0]!.title).toBe("בראשית");
    g.back();
    expect(g.step.value).toBe("db");

    // the planner's default: the base from the commentary's own source — the user's TXT, which the library calls a Sefaria book
    const issue = g.preflight.value.find((p) => p.code === "sefaria/not-library-edition")!;
    expect(issue.books).toEqual(["ביאור חדש על בראשית"]);
    expect(issue.fix).toBe("private");
    expect(issue.text).not.toMatch(/ref_|heRef|line_index/);
    g.setPurpose("private");
    expect(g.preflight.value).toEqual([]);
    g.setPurpose("submission");

    // the database's edition as the base: nothing the library refuses
    const db = store.sources.value.find((s) => s.info.kind === "otzaria-db")!;
    g.setPreferSource(db.info.id);
    expect(g.preflight.value).toEqual([]);
    const pair = g.plan.value!.steps.find((s) => s.kind === "pair")!;
    expect(pair.kind === "pair" && [pair.source.key, pair.target.key].some((k) => k.startsWith(`${db.info.id}:`))).toBe(true);
  });

  it("progress survives a reload: the record in the browser, the flow continued, its books asked for again", async () => {
    const kv = memoryKv();
    const first = makeStore().store;
    first.guided.startPersist(kv, 0);
    first.guided.start();
    await first.guided.addBooks([commentary("ביאור א על בראשית")]);
    await first.guided.addBases([DB]);
    first.guided.next();
    first.guided.next(); // the database holds the base: no database step
    first.exportPurpose.value = "private";
    expect(first.guided.step.value).toBe("plan");
    await settle();
    const rec = JSON.parse(kv.data.get(GUIDED_KEY)!);
    expect(rec).toMatchObject({ step: "plan", purpose: "private", done: false, sources: [{ label: expect.any(String), kind: "text-files", books: 1, files: ["ביאור א על בראשית.txt"] }] });

    // a new page: the same browser storage
    const { store } = makeStore();
    store.guided.startPersist(kv, 0);
    await settle();
    expect(store.guided.saved.value?.step).toBe("plan");
    store.guided.continueSaved();
    expect([store.screen.value, store.guided.step.value, store.guided.resumeTo.value, store.exportPurpose.value]).toEqual(["guided", "files", "plan", "private"]);
    await settle();
    // still waiting for its books: the record keeps where it was
    expect(JSON.parse(kv.data.get(GUIDED_KEY)!).step).toBe("plan");
    await store.guided.addBooks([commentary("ביאור א על בראשית")]);
    await store.guided.addBases([DB]);
    store.guided.resume();
    expect(store.guided.step.value).toBe("plan");
  });
});
