import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Managing existing links (V5 P1-9), end to end without UI on the real schema-7 slice
 * tests/fixtures/db/seforim-v7-mini.db: the database's links of ארצות החיים against its links files,
 * two versions of a file, merging several files of the book, and the group fixes — each one undo step.
 *
 * The records: LIB_1 and LIB_2 are REAL — pninimToOtzaria/links/ארצות החיים_links.json in
 * Otzaria/otzaria-library @aa2c293b (the first produced link 13469515). DB_ROWS are the book's other
 * five links in the mini database (link + link_range rows, read with sqlite3 mode=ro), written as the
 * records the generator stores as exactly those rows: 1-based lines, "commentary", the range end of
 * side 1 as line_index_2_end. The edited version changes them on purpose (named below).
 */
const LIB_1 = { line_index_1: 323, heRef_2: 'המאיר לארץ על ארצות החיים, סימן יא, סעיף ד ס"ק יח', path_2: "המאיר לארץ על ארצות החיים.txt", line_index_2: 1307, start: 33, "Conection Type": "commentary" };
const LIB_2 = { ...LIB_1, heRef_2: 'המאיר לארץ על ארצות החיים, סימן יא, סעיף ד ס"ק יט', line_index_2: 1309, start: 55 };
const YEHUDA = "ארץ יהודה על ארצות החיים";
const MEIR = "המאיר לארץ על ארצות החיים";
const rec = (s: number, title: string, t: number, end?: number) => ({ line_index_1: s, heRef_2: `${title} ${t}`, path_2: `${title}.txt`, line_index_2: t, ...(end && { line_index_2_end: end }), "Conection Type": "commentary" });
const DB_ROWS = [rec(333, YEHUDA, 314, 317), rec(397, YEHUDA, 450, 455), rec(425, MEIR, 1979), rec(613, YEHUDA, 672, 711), rec(613, MEIR, 2663)];
const FILE_NAME = "ארצות החיים_links.json";
const V1 = JSON.stringify([LIB_1, ...DB_ROWS], null, 2);
// the edited version: 397's range ends at 460, 425 now points at 1980, 613 → המאיר is gone, 500 → 2000 is new
const V2 = JSON.stringify([LIB_1, DB_ROWS[0], rec(397, YEHUDA, 450, 460), rec(425, MEIR, 1980), DB_ROWS[3], rec(500, MEIR, 2000)], null, 2);

async function opened() {
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(registryService(new SourceRegistry()), { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  await store.openFiles([{ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) }]);
  return { store, saved };
}

describe("comparing a book's links: database, files, project", () => {
  it("the database against the library file: every row is the same stored link, also the ranges", async () => {
    const { store, saved } = await opened();
    expect(store.compare.addFiles([{ path: `pninimToOtzaria/links/${FILE_NAME}`, text: V1 }])).toEqual(["ארצות החיים"]);
    expect(await store.compare.loadDb("ארצות החיים")).toBe(true);
    const sets = store.compare.setsOf("ארצות החיים");
    expect(sets.map((s) => [s.kind, s.links.length])).toEqual([["file", 6], ["db", 6]]);
    const d = store.compare.compare("ארצות החיים", "db:ארצות החיים", "file:0")!;
    expect(d.loose).toBe(true);
    expect(d.counts.same).toBe(6);
    expect(d.rows).toHaveLength(6);

    // the edited version: one of each, by meaning
    store.compare.addFiles([{ path: FILE_NAME, text: V2 }]);
    const e = store.compare.compare("ארצות החיים", "db:ארצות החיים", "file:1")!;
    expect(e.counts).toMatchObject({ same: 3, range: 1, target: 1, removed: 1, added: 1 });
    expect(e.rows.find((r) => r.kind === "removed")!.a!.target).toMatchObject({ line: 2662 });
    expect(e.rows.find((r) => r.kind === "target")).toMatchObject({ a: { target: { line: 1978 } }, b: { target: { line: 1979 } } });
    store.compare.saveReport();
    expect(saved.at(-1)!.name).toBe("השוואת קישורים - ארצות החיים.csv");
    expect((saved.at(-1)!.data as string).split("\r\n").filter(Boolean)).toHaveLength(1 + 7);

    // the two versions of the file: the same changes, record by record; the real second record is only in the file
    const v = store.compare.compare("ארצות החיים", "file:0", "file:1")!;
    expect(v.loose).toBe(false);
    expect(v.counts).toMatchObject({ same: 3, range: 1, target: 1, removed: 1, added: 1 });
    store.compare.addFiles([{ path: FILE_NAME, text: JSON.stringify([LIB_1, LIB_2]) }]);
    const real = store.compare.compare("ארצות החיים", "db:ארצות החיים", "file:2")!;
    expect(real.counts).toMatchObject({ same: 1, added: 1, removed: 5 });
  });

  it("merges two versions losslessly as one undoable action, and exports the preferred file unchanged plus the addition", async () => {
    const { store } = await opened();
    store.compare.addFiles([{ path: `a/${FILE_NAME}`, text: V1 }, { path: `b/${FILE_NAME}`, text: V2 }]);
    const plan = store.compare.planMerge("ארצות החיים", ["file:0", "file:1"], "file:0", false)!;
    expect(plan.merge.entries.filter((e) => e.base)).toHaveLength(6);
    expect(plan.merge.duplicates).toBe(3);
    expect(plan.merge.conflicts.map((c) => c.kind).sort()).toEqual(["range", "target"]);
    expect(plan.preview.counts).toMatchObject({ same: 6, added: 1 });

    expect(store.compare.applyMerge("ארצות החיים", ["file:0", "file:1"], "file:0", false)).toBe(1);
    const links = store.allLinks.value;
    expect(links.filter((l) => l.provenance === "file")).toHaveLength(6);
    const added = links.find((l) => l.provenance === "import")!;
    expect(added).toMatchObject({ status: "new", source: { line: 499 }, target: { line: 1999 }, origins: [`b/${FILE_NAME}`] });
    // two files of one name: their paths tell them apart, and every link keeps where it was found
    expect(links.find((l) => l.provenance === "file" && l.source.line === 322)!.origins).toEqual([`a/${FILE_NAME}`, `b/${FILE_NAME}`]);
    expect(links.find((l) => l.provenance === "file" && l.source.line === 612 && l.target.book.title === MEIR)!.origins).toEqual([`a/${FILE_NAME}`]);
    expect(store.dbLinks.linksFile("ארצות החיים")).toBe("imported");

    // the export writes the preferred file's records exactly, in order, and the new link after them
    const exp = (await store.exchange.prepareExport())!;
    const file = exp.files.find((f) => f.name === FILE_NAME)!;
    expect(file.text.startsWith(V1.slice(0, -2))).toBe(true);
    expect(JSON.parse(file.text)).toEqual([LIB_1, ...DB_ROWS, expect.objectContaining({ line_index_1: 500, line_index_2: 2000 })]);

    // one undo takes the whole merge back, the file record too
    store.undo();
    expect(store.allLinks.value).toEqual([]);
    expect(store.dbLinks.linksFile("ארצות החיים")).toBe("missing");
  });

  /*
   * V7 §1.7 (unverifiable): a record of a compared file that the parser cannot decode was dropped from the set without a
   * word — the comparison then said nothing about it, as if the file did not hold it. It is counted on the set and said
   * when the file is added, and a merge that keeps such a file as the book's file says the record is not in it.
   */
  it("a record of a compared file that cannot be read is counted and said, never left out silently", async () => {
    const { store } = await opened();
    const broken = JSON.stringify([LIB_1, { ...DB_ROWS[0], line_index_2: "x" }, DB_ROWS[1]], null, 2);
    const before = store.notices.value.length;
    store.compare.addFiles([{ path: `a/${FILE_NAME}`, text: broken }, { path: `b/${FILE_NAME}`, text: V1 }]);
    const [a, b] = store.compare.setsOf("ארצות החיים");
    expect([a!.links.length, a!.unreadable, b!.links.length, b!.unreadable ?? 0]).toEqual([2, 1, 6, 0]);
    const said = store.notices.value.slice(before);
    expect(said.filter((n) => n.kind === "warning").map((n) => n.text)).toEqual([expect.stringMatching(/a\/ארצות החיים_links\.json.*רשומה אחת.*לא הושוו/)]);
    // the merge that keeps the broken file as the book's file says that the record is not in it
    const mark = store.notices.value.length;
    expect(store.compare.applyMerge("ארצות החיים", ["file:0", "file:1"], "file:0", false)).toBe(4);
    expect(store.notices.value.slice(mark).some((n) => n.kind === "warning" && /רשומה אחת.*לא נקראה/.test(n.text))).toBe(true);
  });

  it("never overwrites: a file is not preferred over an edited copy in the project; the project as base adds only what is new", async () => {
    const { store } = await opened();
    store.exchange.importLinksFile(FILE_NAME, V1);
    const first = store.allLinks.value.find((l) => l.source.line === 332)!;
    store.setType([first.id], "reference");
    store.compare.addFiles([{ path: FILE_NAME, text: V2 }]);
    const before = store.linkState.value;
    expect(store.compare.applyMerge("ארצות החיים", ["file:0"], "file:0", false)).toBeNull(); // one source: no merge
    expect(store.compare.planMerge("ארצות החיים", ["project", "file:0"], "file:0", false)).toBeNull(); // the project is always the base
    store.compare.sets.value = [...store.compare.sets.value, { ...store.compare.sets.value[0]!, id: "file:9", name: "c.json" }];
    expect(store.compare.applyMerge("ארצות החיים", ["file:0", "file:9"], "file:0", false)).toBeNull();
    expect(store.linkState.value).toBe(before);

    expect(store.compare.applyMerge("ארצות החיים", ["project", "file:0"], "project", true)).toBe(4);
    // conflicts kept on request: the edited type (333), the range (397), the target (425), and the new 500
    const imported = store.allLinks.value.filter((l) => l.provenance === "import");
    expect(imported.map((l) => l.source.line + 1).sort()).toEqual([333, 397, 425, 500]);
    expect(store.allLinks.value.find((l) => l.source.line === 322)!.origins).toEqual([FILE_NAME]);
  });
});

describe("group fixes on the links table — one undo step each", () => {
  it("duplicates, ranges, direction and target", async () => {
    const { store } = await opened();
    store.exchange.importLinksFile(FILE_NAME, V1);
    store.compare.addFiles([{ path: FILE_NAME, text: V2 }]);
    store.compare.applyMerge("ארצות החיים", ["project", "file:0"], "project", true);
    const all = () => store.allLinks.value.filter((l) => l.status !== "deleted");
    const ids = all().map((l) => l.id);
    const steps = store.linkState.value.undo.length;

    // the 397 range variant is the same stored link as the library record: it goes, the record stays
    expect(store.fixes.removeDuplicates(ids)).toBe(1);
    expect(store.linkState.value.undo.length).toBe(steps + 1);
    expect(all().filter((l) => l.source.line === 396).map((l) => l.provenance)).toEqual(["file"]);

    // a range past the end of the book and one that swallows the next link on the same book
    const meir = all().filter((l) => l.target.book.title === MEIR && l.provenance === "import");
    const target = [...store.books.value.values()].find((b) => b.title === MEIR)!;
    const s = store.linkState.value;
    const [x, y] = meir.sort((a, b) => a.target.line - b.target.line);
    store.linkState.value = { ...s, links: new Map(s.links).set(x!.id, { ...x!, target: { ...x!.target, end: y!.target.line + 5 } }).set(y!.id, { ...y!, target: { ...y!.target, end: (target.lineCount ?? 99999) + 10 } }) };
    expect(store.fixes.fixRanges([x!.id, y!.id])).toBe(2);
    const [fx, fy] = [store.linkState.value.links.get(x!.id)!, store.linkState.value.links.get(y!.id)!];
    expect(fx.target.end).toBe(y!.target.line - 1);
    expect(fy.target.end).toBe(target.lineCount! - 1);

    // a commentary record from the commentary to its base is written "source"
    store.fixes.retarget([fy.id], "ארצות החיים");
    const turned = store.linkState.value.links.get(fy.id)!;
    expect(turned.target.book.title).toBe("ארצות החיים");
    const back = store.linkState.value;
    const swapped = { ...turned, source: { book: turned.target.book, line: 1 }, target: { book: store.resolveTitle(MEIR)!, line: 5 }, declaredType: "commentary" };
    store.linkState.value = { ...back, links: new Map(back.links).set(fy.id, swapped) };
    expect(store.fixes.fixDirection([fy.id])).toBe(0); // the base → its commentary is right as it is
    store.linkState.value = { ...back, links: new Map(back.links).set(fy.id, { ...swapped, source: swapped.target, target: swapped.source }) };
    expect(store.fixes.fixDirection([fy.id])).toBe(1);
    expect(store.linkState.value.links.get(fy.id)!.declaredType).toBe("source");
    store.undo();
    expect(store.linkState.value.links.get(fy.id)!.declaredType).toBe("commentary");
  });
});
