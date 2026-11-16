import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { exportAccounting } from "../../../src/formats/links-json/export";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { BULK_DEFAULT_LEVELS } from "../../../src/state/suggestions";
import { registryService } from "../../support/books-service";

/*
 * Approving many suggestions together (V5 UX audit U21, the owner's decision): what a choice takes is
 * counted before anything is approved — per level, and the file records it writes — "possible" and
 * "ambiguous" only when asked for; the approval is the ordinary one, ONE undoable step; and what was
 * approved is what the export writes and accounts for.
 */
const require = createRequire(import.meta.url);
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"][n]!;
const text = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const commentary = (title: string) => text(`${title}.txt`, [`<h1>${title}</h1>`, "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat()]);
// no verse headings: found by its opening words, so not all of it is certain
const noHeadings = text("פירוש קצר על בראשית.txt", ["<h1>פירוש קצר על בראשית</h1>", "בראשית ברא - בשביל התורה.", "והארץ היתה תהו ובהו - תמהה ומשוממה.", "ורוח אלהים מרחפת - כסא הכבוד.", "ויבדל אלהים - ראהו שאינו כדאי."]);

const makeStore = () => new AppStore(registryService(new SourceRegistry()), { save: () => undefined }, loadPreferences(null));
const live = (store: AppStore) => [...store.linkState.value.links.values()].filter((l) => l.status !== "deleted");

async function ranGuided() {
  const store = makeStore();
  const g = store.guided;
  g.start();
  await g.addBooks([commentary("ביאור א על בראשית"), commentary("ביאור ב על בראשית"), noHeadings]);
  g.next();
  g.next();
  await g.addBases([DB]);
  g.next();
  expect(await g.run()).toBe(true);
  return store;
}

describe("bulk approval — counted first, one undoable step", () => {
  it("the default levels are certain and high; the preview's count is exactly what is approved, and one undo takes it all back", async () => {
    const store = await ranGuided();
    const sg = store.suggestions;
    const all = sg.run.value!.result.suggestions;
    const levelsInRun = new Set(all.map((s) => s.confidence));
    expect(levelsInRun.has("certain")).toBe(true);
    expect([...BULK_DEFAULT_LEVELS]).toEqual(["certain", "high"]);

    const preview = sg.bulkPreview({ levels: BULK_DEFAULT_LEVELS });
    const expected = all.filter((s) => s.confidence === "certain" || s.confidence === "high");
    expect(preview.ids.sort()).toEqual(expected.map((s) => s.id).sort());
    expect(preview.byLevel.certain).toBe(all.filter((s) => s.confidence === "certain").length);
    expect(preview.byLevel.possible).toBeUndefined();
    expect(preview.byLevel.ambiguous).toBeUndefined();
    expect(preview.records).toBe(preview.ids.length); // no Sefaria span here: a record per suggestion

    const undoBefore = store.linkState.value.undo.length;
    expect(sg.approve(preview.ids)).toBe(preview.ids.length);
    expect(store.linkState.value.undo.length).toBe(undoBefore + 1);
    expect(store.linkState.value.undo.at(-1)!.label).toBe(`אישור ${preview.ids.length.toLocaleString("he")} הצעות`);
    expect(live(store)).toHaveLength(preview.records);
    for (const id of preview.ids) expect(sg.state.value.get(id)).toBe("approved");
    // nothing below "high" was approved
    for (const s of all.filter((x) => x.confidence === "possible" || x.confidence === "ambiguous")) expect(sg.state.value.get(s.id)).toBe("pending");
    // approved, nothing pending is left at those levels
    expect(sg.bulkPreview({ levels: BULK_DEFAULT_LEVELS }).ids).toEqual([]);

    store.undo();
    expect(live(store)).toHaveLength(0);
    for (const id of preview.ids) expect(sg.state.value.get(id)).toBe("pending");
    store.redo();
    expect(live(store)).toHaveLength(preview.records);

    // the export writes what was approved, and accounts for every link
    const plan = (await store.exchange.prepareExport())!;
    expect(exportAccounting(store.allLinks.value, plan)).toEqual([]);
    expect(plan.written.length + plan.heldBack.length).toBe(preview.records);
  });

  it("narrowed to one book or one method; lower levels only when ticked", async () => {
    const store = await ranGuided();
    const sg = store.suggestions;
    const all = sg.run.value!.result.suggestions;
    const groups = sg.bulkGroups();
    expect(groups.books.map((b) => b.title)).toContain("ביאור א על בראשית");
    expect(groups.books[0]!.title).toBe("בראשית"); // the base is on every suggestion's other side
    const one = sg.bulkPreview({ levels: BULK_DEFAULT_LEVELS, book: "ביאור א על בראשית" });
    expect(one.ids.length).toBeGreaterThan(0);
    for (const id of one.ids) {
      const s = all.find((x) => x.id === id)!;
      expect([s.source.book.title, s.target.book.title]).toContain("ביאור א על בראשית");
    }
    const engine = groups.engines[0]!.id;
    for (const id of sg.bulkPreview({ levels: BULK_DEFAULT_LEVELS, engine }).ids) expect(all.find((x) => x.id === id)!.engine).toBe(engine);

    const every = sg.bulkPreview({ levels: ["certain", "high", "possible", "ambiguous"] });
    expect(every.ids.length).toBe(all.filter((s) => s.confidence !== "none").length);
    expect(every.ids.length).toBeGreaterThanOrEqual(sg.bulkPreview({ levels: BULK_DEFAULT_LEVELS }).ids.length);
  });

  it("a suggestion on a Sefaria span counts once, with the records it writes", async () => {
    const SQL = await initSqlJs({ locateFile: (f: string) => require.resolve(`sql.js/dist/${f}`) });
    const db = new SQL.Database();
    db.exec(readFileSync("tests/fixtures/schemas/v5.sql", "utf8"));
    db.run("insert into source(id,name) values(1,'אישי')");
    db.run("insert into category(id,parentId,title,level) values(1,null,'ספרייה',0)");
    const lines: [string, string | null][] = [["<h1>בראשית</h1>", null], ["<h2>פרק א</h2>", null], ["דיני הפרק הראשון", null], ...["א", "ב", "ג", "ד"].map((h, i): [string, string | null] => [`פסוק ${h} ויאמר אלהים דבר ${i}`, `בראשית, א, ${h}`])];
    db.run("insert into book(id,categoryId,sourceId,title,totalLines) values(1,1,1,'בראשית',?)", [lines.length]);
    lines.forEach(([t, heRef], j) => db.run("insert into line(id,bookId,lineIndex,content,heRef,charCount) values(?,?,?,?,?,?)", [j + 1, 1, j, t, heRef, t.length]));
    const store = new AppStore(registryService(), { save: () => undefined }, loadPreferences(null));
    await store.openFiles([{ path: "מקורות.db", blob: new Blob([new Uint8Array(db.export())]) }, text("s1/ביאור חדש על בראשית.txt", ["<h1>ביאור חדש על בראשית</h1>", "<h2>פרק א</h2>", "הסבר כללי על כל הפרק."])]);
    const book = (title: string) => [...store.books.value.values()].find((b) => b.title === title)!;
    const base = book("בראשית");
    store.setLibrarySource(base.key.slice(0, base.key.indexOf(":")), true);
    expect(await store.suggestions.runEngine("headings", book("ביאור חדש על בראשית").key, base.key)).toBe(true);
    const [s] = store.suggestions.run.value!.result.suggestions;
    const preview = store.suggestions.bulkPreview({ levels: [s!.confidence] });
    expect(preview).toEqual({ ids: [s!.id], byLevel: { [s!.confidence]: 1 }, records: 4 });
    expect(store.suggestions.approve(preview.ids)).toBe(1);
    expect(live(store)).toHaveLength(4);
  });
});
