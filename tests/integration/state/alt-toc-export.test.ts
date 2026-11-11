import { readFileSync } from "node:fs";
import { strFromU8, strToU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { entriesFromHeadings, numberInGematria } from "../../../src/core/alt-toc/edit";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, KeyValueStore } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { batchJob, diffJob, engineJob } from "../../../src/workers/engine-job";
import { searchJob } from "../../../src/workers/search-job";
import { citationsJob } from "../../../src/workers/citations-job";

function makeStore() {
  const reg = new SourceRegistry();
  const service: BooksService = {
    open: (f) => reg.open(f),
    openMapped: (t, m) => reg.openMapped(t, m),
    lines: (k, a, b) => reg.lines(k, a, b),
    existingLinks: (k, a, b) => reg.existingLinks(k, a, b),
    close: async (id) => reg.close(id),
    runEngine: (e, s, t, o) => engineJob(reg, e, s, t, o, {}),
    runBatch: (e, pairs, o) => batchJob(reg, e, pairs, o, {}),
    diffBooks: (a, b) => diffJob(reg, a, b),
    altToc: (k) => reg.altToc(k),
    headings: (k) => reg.headings(k),
    searchBook: (k, q, o) => searchJob(reg, k, q, o),
    runCitations: (s, o) => citationsJob(reg, s, o, {}),
  };
  const saved: { name: string; data: Uint8Array | string; mime: string }[] = [];
  const store = new AppStore(service, { save: (name, data, mime) => saved.push({ name, data, mime }) }, loadPreferences(null));
  return { store, saved };
}
const NL = String.fromCharCode(10);
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
/** a small book of my own: two parashot of three "verses" each */
const BOOK = {
  path: "חומש שלי.txt",
  blob: new Blob([strToU8(["<h1>חומש שלי</h1>", "<h2>פרשה א</h2>", "פסוק 1", "פסוק 2", "פסוק 3", "<h2>פרשה ב</h2>", "פסוק 4", "פסוק 5", "פסוק 6"].join(NL))]),
};
const COMMENTARY = { path: "פירוש על חומש שלי.txt", blob: new Blob([strToU8(["<h1>פירוש על חומש שלי</h1>", "<h2>פרשה א</h2>", "פירוש, \"ראשון\""].join(NL))]) };
const unzip = (data: Uint8Array | string) => Object.fromEntries(Object.entries(unzipSync(data as Uint8Array)).map(([k, v]) => [k, strFromU8(v)]));

describe("AppStore — alt_toc", () => {
  it("fill from headings → number → save (one undo step) → export as ZIP with alt_toc/ and _report.txt", async () => {
    const { store, saved } = makeStore();
    await store.openFiles([BOOK, COMMENTARY]);
    const book = [...store.books.value.values()].find((b) => b.title === "חומש שלי")!;
    const comm = [...store.books.value.values()].find((b) => b.title === "פירוש על חומש שלי")!;

    expect(await store.altToc.fromLibrary(book.key)).toBeNull(); // a text book has no database structures
    const hs = (await store.altToc.headings(book.key))!;
    const filled = entriesFromHeadings(hs.slice(1)).map((e) => ({ ...e, level: 0 }));
    const entries = [filled[0]!, { heTitle: "x", line: 3, level: 1 }, { heTitle: "x", line: 5, level: 1 }, filled[1]!, { heTitle: "x", line: 7, level: 1 }];
    store.altToc.set("חומש שלי", [{ key: "Parasha", heTitle: "פרשה", entries: numberInGematria(entries, "עליה").entries }]);
    expect(store.altToc.count.value).toBe(1);
    expect(store.dirty.value).toBe(true);
    store.undo();
    expect(store.altToc.of("חומש שלי")).toBeUndefined();
    store.redo();

    await store.lines.load(comm.key, 0, 2);
    store.pickLine("source", comm.key, 2);
    store.pickLine("target", book.key, 2);
    store.createFromDraft();

    const plan = (await store.prepareExport())!;
    expect(plan.altToc.files.map((f) => f.name)).toEqual(["חומש שלי_alt_toc.json"]);
    store.saveExport(plan);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toMatch(/^links-\d{4}-\d\d-\d\d\.zip$/);
    const files = unzip(saved[0]!.data);
    expect(Object.keys(files).sort()).toEqual(["_report.txt", "alt_toc/חומש שלי_alt_toc.json", "links/פירוש על חומש שלי_links.json"]);
    expect(JSON.parse(files["alt_toc/חומש שלי_alt_toc.json"]!)).toEqual([
      {
        key: "Parasha",
        heTitle: "פרשה",
        nodes: [
          { heTitle: "פרשה א", line: 2, children: [{ heTitle: "עליה א", line: 3 }, { heTitle: "עליה ב", line: 5 }] },
          { heTitle: "פרשה ב", line: 6, children: [{ heTitle: "עליה א", line: 7 }] },
        ],
      },
    ]);
    expect(files["_report.txt"]).toContain("alt_toc/חומש שלי_alt_toc.json  (1 מבנים, 5 צמתים)");
    expect(files["_report.txt"]).toContain("links/פירוש על חומש שלי_links.json");
    expect(store.dirty.value).toBe(false);
  });

  it("a structure with a line past the end of the book is held back whole; the report says why", async () => {
    const { store, saved } = makeStore();
    await store.openFiles([BOOK]);
    store.altToc.set("חומש שלי", [{ key: "Parasha", heTitle: "פרשה", entries: [{ heTitle: "א", line: 2, level: 0 }, { heTitle: "ב", line: 500, level: 0 }] }]);
    const plan = (await store.prepareExport())!;
    expect(plan.altToc.files).toEqual([]);
    expect(plan.altToc.heldBack[0]!.problems.map((p) => p.code)).toEqual(["alt-toc/line-out-of-range"]);
    store.saveReport(plan);
    expect(saved[0]!.name).toBe("_report.txt");
    expect(saved[0]!.data).toContain("מבני כותרות שלא ייוצאו (1)");
  });

  it("an imported _alt_toc.json becomes the book's structures (origin file); alone it exports as that one file", async () => {
    const { store, saved } = makeStore();
    const text = JSON.stringify([{ key: "Parasha", heTitle: "פרשה", nodes: [{ heTitle: "פרשה א", line: 2 }] }], null, 2);
    await store.openFiles([BOOK, { path: "alt_toc/חומש שלי_alt_toc.json", blob: new Blob([text]) }]);
    expect(store.altToc.of("חומש שלי")).toMatchObject({ origin: "file", structures: [{ key: "Parasha" }] });
    const plan = (await store.prepareExport())!;
    store.saveExport(plan);
    expect(saved).toEqual([{ name: "חומש שלי_alt_toc.json", data: text, mime: "application/json" }]); // untouched → same bytes
  });

  it("a database book starts from its structures; Sefaria's book is flagged; automatic keys are set apart", async () => {
    const { store } = makeStore();
    await store.openFiles([DB]);
    const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    const mb = [...store.books.value.values()].find((b) => b.title === "משנה ברורה")!;
    const lib = (await store.altToc.fromLibrary(bereshit.key))!;
    expect(lib.editable.map((s) => s.key)).toEqual(["Parasha"]);
    expect(store.altToc.context("בראשית").sefaria).toBe(true);
    const mbLib = (await store.altToc.fromLibrary(mb.key))!;
    expect([mbLib.editable.length, mbLib.automatic.map((s) => s.key)]).toEqual([0, ["Seifim", "SimanNames"]]);
  });

  it("an emptied list that came from the database is exported as [] (removes the structures from the library)", async () => {
    const { store, saved } = makeStore();
    await store.openFiles([BOOK]);
    store.altToc.set("חומש שלי", [], { origin: "db" });
    const plan = (await store.prepareExport())!;
    store.saveExport(plan);
    expect(saved[0]).toMatchObject({ name: "חומש שלי_alt_toc.json", data: "[]" });
  });

  it("is saved in the project and in autosave, and comes back when the project is opened", async () => {
    const a = makeStore();
    await a.store.openFiles([BOOK]);
    a.store.altToc.set("חומש שלי", [{ key: "Parasha", heTitle: "פרשה", entries: [{ heTitle: "א", line: 2, level: 0 }] }]);
    const text = a.store.projectText();
    const b = makeStore();
    b.store.openProject("p.otzlinker.json", text);
    expect(b.store.altToc.of("חומש שלי")!.structures[0]!.entries).toEqual([{ heTitle: "א", line: 2, level: 0 }]);
    b.store.undo(); // opening the project is one step, alt_toc included
    expect(b.store.altToc.count.value).toBe(0);

    const kv = new Map<string, string>();
    const store: KeyValueStore = { get: async (k) => kv.get(k) ?? null, set: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) };
    const c = makeStore();
    const stop = c.store.startAutosave(store, 0);
    c.store.altToc.set("ספר", [{ key: "A", entries: [{ heTitle: "א", line: 1, level: 0 }] }]);
    await new Promise((r) => setTimeout(r, 10));
    stop();
    expect(JSON.parse(kv.get("autosave:v1")!).altToc).toHaveLength(1);
  });
});

describe("AppStore — Sefaria-layout CSV export", () => {
  it("citations from the source's headings, heRef_2 as the second; one book → one .links.csv", async () => {
    const { store, saved } = makeStore();
    await store.openFiles([BOOK, COMMENTARY]);
    const book = [...store.books.value.values()].find((b) => b.title === "חומש שלי")!;
    const comm = [...store.books.value.values()].find((b) => b.title === "פירוש על חומש שלי")!;
    await store.lines.load(comm.key, 0, 2);
    await store.lines.load(book.key, 0, 8);
    store.pickLine("source", comm.key, 2);
    store.pickLine("target", book.key, 2);
    store.draftHeRef.value = "חומש שלי, פרשה א, 1";
    store.createFromDraft();
    const plan = (await store.prepareExport())!;
    const csv = (await store.prepareSefariaCsv(plan))!;
    expect(csv.map((f) => f.name)).toEqual(["פירוש על חומש שלי.links.csv"]);
    expect(csv[0]!.text).toBe(["Citation 1,Citation 2,Conection Type", '"פירוש על חומש שלי, פרשה א","חומש שלי, פרשה א, 1",source'].join(NL));
    store.saveExport(plan, csv);
    expect(saved).toEqual([{ name: "פירוש על חומש שלי.links.csv", data: csv[0]!.text, mime: "text/csv;charset=utf-8" }]);
  });
});
