import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { exportAccounting } from "../../../src/formats/links-json/export";
import { tableRows } from "../../../src/state/links-table";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";
import { loadSqlJs } from "../../support/sql-js";

/*
 * A span cut on a Sefaria base, from suggestion to export (LIBRARY_BENCHMARK.md §0.8, the owner's decision
 * of 2026-11-16): the reviewer sees ONE suggestion; approving it makes one single-line link per line of a
 * short span that has a heRef — each with its own ref_2 in the export, which writes and accounts for every
 * one — rejecting (or undoing) removes them all, and a record the project already has is not written twice.
 */
const HEB = ["א", "ב", "ג", "ד", "ה", "ו"];
/** פרק א: heading (1), a name line without a heRef (2), four verses with heRefs (3..6) */
const BASE_LINES: [string, string | null][] = [
  ["<h1>בראשית</h1>", null],
  ["<h2>פרק א</h2>", null],
  ["דיני הפרק הראשון", null],
  ...HEB.slice(0, 4).map((h, i): [string, string | null] => [`פסוק ${h} ויאמר אלהים דבר ${i}`, `בראשית, א, ${h}`]),
];
const COMM = { path: "s1/ביאור חדש על בראשית.txt", blob: new Blob([strToU8(["<h1>ביאור חדש על בראשית</h1>", "<h2>פרק א</h2>", "הסבר כללי על כל הפרק."].join("\n"))]) };

/** a database in the Otzaria schema whose בראשית has heRefs; the user marks its source as the library's */
async function baseDb() {
  const SQL = await loadSqlJs();
  const db = new SQL.Database();
  db.exec(readFileSync("tests/fixtures/schemas/v5.sql", "utf8"));
  db.run("insert into source(id,name) values(1,'אישי')");
  db.run("insert into category(id,parentId,title,level) values(1,null,'ספרייה',0)");
  db.run("insert into book(id,categoryId,sourceId,title,totalLines) values(1,1,1,'בראשית',?)", [BASE_LINES.length]);
  BASE_LINES.forEach(([text, heRef], j) => db.run("insert into line(id,bookId,lineIndex,content,heRef,charCount) values(?,?,?,?,?,?)", [j + 1, 1, j, text, heRef, text.length]));
  return { path: "מקורות.db", blob: new Blob([new Uint8Array(db.export())]) };
}

async function setup() {
  const store = new AppStore(registryService(), { save: () => undefined }, loadPreferences(null));
  await store.openFiles([await baseDb(), COMM]);
  const book = (title: string) => [...store.books.value.values()].find((b) => b.title === title)!;
  const base = book("בראשית");
  store.setLibrarySource(base.key.slice(0, base.key.indexOf(":")), true);
  expect(store.isSefariaOwned(store.refOf(base.key))).toBe(true);
  expect(await store.suggestions.runEngine("headings", book("ביאור חדש על בראשית").key, base.key)).toBe(true);
  const [s] = store.suggestions.run.value!.result.suggestions;
  return { store, s: s! };
}
const live = (store: AppStore) => [...store.linkState.value.links.values()].filter((l) => l.status !== "deleted");

describe("a short span on a Sefaria base: one suggestion, a link per line", () => {
  it("approving writes the four verses (not the name line), each with its own ref_2, and the export accounts for all", async () => {
    const { store, s } = await setup();
    expect(store.suggestions.run.value!.result.suggestions.length).toBe(1);
    expect(s.citedSpan).toEqual({ line: 2, end: 6 });
    expect(s.spanLines?.map((x) => x.line)).toEqual([3, 4, 5, 6]);
    expect(store.suggestions.approve([s.id])).toBe(1);
    expect(store.suggestions.state.value.get(s.id)).toBe("approved");
    const links = live(store);
    expect(links.map((l) => [l.target.line, l.target.end, l.heRef2])).toEqual([
      [3, undefined, "בראשית, א, א"],
      [4, undefined, "בראשית, א, ב"],
      [5, undefined, "בראשית, א, ג"],
      [6, undefined, "בראשית, א, ד"],
    ]);
    // the links table reads every record back to the one suggestion
    expect(tableRows(links, store.suggestions.run.value!.result.suggestions).filter((r) => r.suggestion === s.id).length).toBe(4);

    const plan = (await store.exchange.prepareExport())!;
    expect(plan.heldBack.filter((h) => h.problems.some((p) => p.severity === "error"))).toEqual([]);
    expect(plan.written.map((l) => l.ref2)).toEqual(["Genesis 1:1", "Genesis 1:2", "Genesis 1:3", "Genesis 1:4"]);
    expect(plan.files.reduce((a, f) => a + f.records, 0)).toBe(4);
    expect(exportAccounting(store.allLinks.value, plan)).toEqual([]);
  });

  it("rejecting it removes every record — one undoable action", async () => {
    const { store, s } = await setup();
    store.suggestions.approve([s.id]);
    expect(live(store).length).toBe(4);
    store.suggestions.reject([s.id]);
    expect(live(store).length).toBe(0);
    expect(store.suggestions.state.value.get(s.id)).toBe("rejected");
    store.undo();
    expect(live(store).length).toBe(4);
    store.undo();
    expect(live(store).length).toBe(0);
    expect(store.suggestions.state.value.get(s.id)).toBe("pending");
  });

  it("a record the project already has is not written again; with every record there the suggestion 'exists'", async () => {
    const { store, s } = await setup();
    // the user already linked the commentary line to verse 2 (line 4)
    const mine = { id: "user:1", status: "new" as const, provenance: "user" as const, source: s.source, target: { book: s.target.book, line: 4 }, declaredType: "commentary", heRef2: "בראשית, א, ב" };
    store.linkState.value = { ...store.linkState.value, links: new Map([...store.linkState.value.links, [mine.id, mine]]) };
    expect(store.suggestions.state.value.get(s.id)).toBe("pending");
    store.suggestions.approve([s.id]);
    expect(live(store).map((l) => l.target.line).sort()).toEqual([3, 4, 5, 6]);
    expect(live(store).filter((l) => l.target.line === 4).map((l) => l.id)).toEqual(["user:1"]);
  });
});
