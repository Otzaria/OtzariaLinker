import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";

/*
 * Compatibility review B1/B6 end to end: links into a Sefaria book need ref_2 for the library's weekly
 * sync. The export builds it from the database heRef when it can, holds the link back when it cannot
 * (submission), and only warns for private use. Real schema-7 slice: בראשית is a Sefaria book whose
 * lines carry heRefs like "בראשית, א, א".
 */
function makeStore() {
  const reg = new SourceRegistry();
  const service = {
    open: (f) => reg.open(f),
    lines: (k, a, b) => reg.lines(k, a, b),
    existingLinks: (k, a, b) => reg.existingLinks(k, a, b),
    close: async (id) => reg.close(id),
    altToc: (k) => reg.altToc(k),
    headings: (k) => reg.headings(k),
  } as BooksService;
  const saved: { name: string; data: Uint8Array | string }[] = [];
  return { store: new AppStore(service, { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null)), saved };
}
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const COMMENTARY = { path: "ביאור חדש על בראשית.txt", blob: new Blob([strToU8("<h1>ביאור חדש על בראשית</h1>\nביאור ראשון\nביאור שני\nביאור שלישי")]) };

async function opened() {
  const { store, saved } = makeStore();
  await store.openFiles([DB, COMMENTARY]);
  const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
  await store.lines.load(bereshit.key, 0, 20);
  const verse = [...Array(20).keys()].find((i) => store.lines.peek(bereshit.key, i)?.heRef?.startsWith("בראשית, א, ")) ?? -1;
  // a sheet of new links from the commentary to Bereshit, without ref_2
  const sheet = (line: number) => `line_index_1,heRef_2,path_2,line_index_2,Conection Type\n2,ב,בראשית.txt,${line + 1},source\n`;
  return { store, saved, bereshit, verse, sheet };
}

describe("ref_2 into a Sefaria book (B1)", () => {
  it("for a submission the export builds ref_2 from the line's heRef, as one undoable action", async () => {
    const { store, saved, bereshit, verse, sheet } = await opened();
    expect(verse).toBeGreaterThanOrEqual(0);
    expect(store.isSefariaOwned({ title: "בראשית" })).toBe(true);
    store.importLinksCsv("ביאור חדש על בראשית_links.csv", sheet(verse));
    const plan = (await store.prepareExport())!;
    expect(plan.heldBack).toEqual([]);
    const heRef = store.lines.peek(bereshit.key, verse)!.heRef!;
    const expected = `Genesis 1:${["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"].indexOf(heRef.split(", ")[2]!) + 1}`;
    expect(store.allLinks.value[0]!.ref2).toBe(expected);
    store.saveExport(plan);
    expect(JSON.parse(saved[0]!.data as string)[0].ref_2).toBe(expected);
    store.undo(); // the filled ref is its own action
    expect(store.allLinks.value[0]!.ref2).toBeUndefined();
  });

  it("a ref that cannot be built holds the link back for a submission, and only warns for private use", async () => {
    const { store } = await opened();
    // רש"י על בראשית is a Sefaria book whose heRef prefix the learned table does not hold
    const rashi = [...store.books.value.values()].find((b) => b.title.startsWith("רש") && b.title.endsWith("על בראשית"))!;
    expect(store.isSefariaOwned(rashi)).toBe(true);
    await store.lines.load(rashi.key, 0, 10);
    const line = [...Array(10).keys()].find((i) => store.lines.peek(rashi.key, i)?.heRef && store.lines.peek(rashi.key, i)?.heading === null)!;
    store.importLinksCsv("ביאור חדש על בראשית_links.csv", `line_index_1,heRef_2,path_2,line_index_2,Conection Type\n2,ב,"${rashi.title.replaceAll('"', '""')}.txt",${line + 1},reference\n`);
    let plan = (await store.prepareExport())!;
    expect(plan.heldBack.flatMap((h) => h.problems.map((p) => p.code))).toContain("sefaria/ref2-required");
    store.exportPurpose.value = "private";
    plan = (await store.prepareExport())!;
    expect(plan.heldBack).toEqual([]);
    expect(plan.warned.flatMap((w) => w.problems.map((p) => `${p.severity}:${p.code}`))).toContain("warning:sefaria/ref2-required");
  });

  it("the library's own list of Sefaria titles replaces the embedded one (B6)", async () => {
    const { store } = await opened();
    const file = { path: "otzaria-library/.github/data/sefaria_he_titles.txt", blob: new Blob(["# test\nמשנה ברורה\n"]) };
    await store.dbLinks.loadLinksFiles([file], []);
    expect(store.sefariaTitles.value.source).toBe("library");
    expect(store.isSefariaOwned({ title: "בראשית" })).toBe(false);
    expect(store.isSefariaOwned({ title: "משנה ברורה" })).toBe(true);
  });
});
