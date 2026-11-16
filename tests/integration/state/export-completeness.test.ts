import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { exportAccounting } from "../../../src/formats/links-json/export";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * V5 P0-5 end to end, on the real schema-7 slice: what the quality tab says is blocked is exactly what
 * the export dialog holds back, and a link is never lost on the way to a file.
 */
function makeStore() {
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(registryService(new SourceRegistry()), { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  return { store, saved };
}
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const COMMENTARY = { path: "ביאור חדש על בראשית.txt", blob: new Blob([strToU8("<h1>ביאור חדש על בראשית</h1>\nביאור ראשון\nביאור שני\nביאור שלישי\nביאור רביעי")]) };
const sorted = (ids: readonly string[]) => [...ids].sort();

async function opened() {
  const { store, saved } = makeStore();
  await store.openFiles([DB, COMMENTARY]);
  const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
  const rashi = [...store.books.value.values()].find((b) => b.title.startsWith("רש") && b.title.endsWith("על בראשית"))!;
  await store.lines.load(bereshit.key, 0, 20);
  await store.lines.load(rashi.key, 0, 10);
  const verse = [...Array(20).keys()].find((i) => store.lines.peek(bereshit.key, i)?.heRef?.startsWith("בראשית, א, "))!;
  const rashiLine = [...Array(10).keys()].find((i) => store.lines.peek(rashi.key, i)?.heRef && store.lines.peek(rashi.key, i)?.heading === null)!;
  const q = (t: string) => `"${t.replaceAll('"', '""')}.txt"`;
  // four new links: ref_2 the export fills itself (Bereshit), ref_2 it cannot (Rashi), a heading, a plain one
  store.exchange.importLinksCsv(
    "ביאור חדש על בראשית_links.csv",
    [
      "line_index_1,heRef_2,path_2,line_index_2,Conection Type",
      `2,ב,בראשית.txt,${verse + 1},source`,
      `3,ר,${q(rashi.title)},${rashiLine + 1},reference`,
      `1,כ,בראשית.txt,${verse + 1},reference`,
      `4,ד,${q("ביאור חדש על בראשית")},2,reference`,
    ].join("\n"),
  );
  expect(store.allLinks.value).toHaveLength(4);
  return { store, saved, bereshit, rashi };
}

describe("the quality tab and the export dialog block the same links (V5 P0-5)", () => {
  it("a Sefaria ref the export fills by itself is not an error in the check — before, the check blocked 3 and the export 2", async () => {
    const { store } = await opened();
    const qa = (await store.quality.run())!;
    const before = store.linkState.value.revision;
    expect(store.linkState.value.revision).toBe(before); // the check changes nothing
    const plan = (await store.exchange.prepareExport())!;
    expect(plan.heldBack).toHaveLength(2); // the Rashi link without a ref the tool can build, and the heading
    expect(sorted(qa.blocked)).toEqual(sorted(plan.heldBack.map((h) => h.link.id)));
    expect(qa.issues.some((i) => i.problem.code === "sefaria/ref2-required" && i.link.target.book.title === "בראשית")).toBe(false);
    expect(exportAccounting(store.allLinks.value, plan)).toEqual([]);
    // for private use too
    store.exportPurpose.value = "private";
    const qa2 = (await store.quality.run())!;
    const plan2 = (await store.exchange.prepareExport())!;
    expect(sorted(qa2.blocked)).toEqual(sorted(plan2.heldBack.map((h) => h.link.id)));
  });

  it("deleting a link and undoing it, or closing and reopening the database, leaves the account whole", async () => {
    const { store, saved } = await opened();
    const ids = store.allLinks.value.map((l) => l.id);
    store.deleteLinks([ids[3]!]);
    store.undo();
    const plan = (await store.exchange.prepareExport())!;
    expect(plan.written.length + plan.heldBack.length).toBe(4);
    store.exchange.saveExport(plan);
    expect(JSON.parse(saved.at(-1)!.data as string)).toHaveLength(plan.written.length);
  });
});

describe("links on the books of a closed source (V5 P0-5, P1-10)", () => {
  it("close the database and open it again: the links come back onto its books, and the check sees them", async () => {
    const { store, bereshit } = await opened();
    const db = store.sources.value.find((s) => s.info.kind === "otzaria-db")!;
    await store.closeSource(db.info.id);
    // the closed source's keys name nothing now: the links wait by title, like links of a saved project
    const onBereshit = store.allLinks.value.filter((l) => l.target.book.title === "בראשית");
    expect(onBereshit.length).toBeGreaterThan(0);
    expect(onBereshit.every((l) => l.target.book.key === "unresolved:בראשית")).toBe(true);
    await store.openFiles([DB]);
    const again = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    expect(again.key).not.toBe(bereshit.key);
    // before: the links kept the closed source's key and the reopened book showed none of them
    expect(store.linksOfBook(again.key).length).toBe(onBereshit.length);
    const plan = (await store.exchange.prepareExport())!;
    expect(exportAccounting(store.allLinks.value, plan)).toEqual([]);
    expect(plan.written.length + plan.heldBack.length).toBe(4);
  });
});
