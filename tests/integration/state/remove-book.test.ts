import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { timeline } from "../../../src/state/history";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Version 3's "remove one book" (F-035): one book of the tool, with the links that touch it, in one action that
 * undo brings back; the file on the disk is untouched. V7 opens files as sources (a folder is one source), so the
 * book leaves the book list, the readers and every screen that lists the open books, while its source stays open.
 */
function makeStore() {
  const reg = new SourceRegistry();
  const store = new AppStore(registryService(reg), { save: () => {} }, loadPreferences(null));
  return store;
}
const txt = (path: string, lines: string[]) => ({ path, blob: new Blob([strToU8(lines.join("\n"))]) });
const BASE = txt("בסיס.txt", ["<h1>בסיס</h1>", "שורה ראשונה", "שורה שנייה", "שורה שלישית"]);
const COMM = txt("פירוש על בסיס.txt", ["<h1>פירוש על בסיס</h1>", "פירוש ראשון", "פירוש שני"]);
const OTHER = txt("אחר.txt", ["<h1>אחר</h1>", "שורה", "שורה"]);
const key = (store: AppStore, title: string) => [...store.books.value.values()].find((b) => b.title === title)!.key;

async function withLinks() {
  const store = makeStore();
  await store.openFiles([BASE, COMM, OTHER]);
  for (const t of ["בסיס", "פירוש על בסיס", "אחר"]) await store.lines.load(key(store, t), 0, 4);
  const link = (s: string, sl: number, t: string, tl: number) => {
    store.pickLine("source", key(store, s), sl);
    store.pickLine("target", key(store, t), tl);
    return store.createFromDraft({ asNew: true })!;
  };
  const a = link("פירוש על בסיס", 1, "בסיס", 1);
  const b = link("פירוש על בסיס", 2, "בסיס", 2);
  const c = link("אחר", 1, "בסיס", 3);
  const d = link("אחר", 2, "פירוש על בסיס", 1);
  return { store, a, b, c, d };
}

describe("removing one book from the tool, with its links (V7 parity F-035)", () => {
  it("the book and the links touching it go in one action; undo brings both back, redo removes them again", async () => {
    const { store, a, b, c, d } = await withLinks();
    const base = key(store, "בסיס");
    store.view.target.value = base;
    const undoBefore = store.linkState.value.undo.length;
    expect(store.removeBook(base)).toBe(true);
    expect(store.books.value.has(base)).toBe(false);
    expect(store.sources.value.flatMap((s) => s.books.map((x) => x.title))).not.toContain("בסיס");
    expect(store.view.target.value).toBeNull();
    expect([...store.linkState.value.links.keys()].sort()).toEqual([d.id]);
    expect(store.linkState.value.undo.length).toBe(undoBefore + 1);
    expect(timeline(store.linkState.value).at(-1)!.label).toBe('הסרת הספר "בסיס"');
    expect(store.notices.value.at(-1)!.text).toContain("3 קישורים");
    store.undo();
    expect(store.books.value.has(base)).toBe(true);
    expect([...store.linkState.value.links.keys()].sort()).toEqual([a.id, b.id, c.id, d.id].sort());
    store.redo();
    expect(store.books.value.has(base)).toBe(false);
    expect(store.linkState.value.links.size).toBe(1);
    // the notice's undo takes it back while nothing else was done
    store.undo();
    store.removeBook(base);
    store.notices.value.at(-1)!.action!.run();
    expect(store.books.value.has(base)).toBe(true);
  });

  it("the other books of the same source stay open; opening the file again brings a removed book back", async () => {
    const { store } = await withLinks();
    const other = key(store, "אחר");
    store.removeBook(other);
    expect(store.books.value.has(key(store, "בסיס"))).toBe(true);
    expect(store.dirty.value).toBe(true);
    await store.openFiles([OTHER]);
    expect([...store.books.value.values()].some((b) => b.title === "אחר")).toBe(true);
  });

  it("a database picked again (the same source, not opened twice) brings its removed book back, as an undoable action", async () => {
    const store = makeStore();
    const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
    await store.openFiles([DB]);
    const bereshit = key(store, "בראשית");
    store.removeBook(bereshit);
    expect(store.books.value.has(bereshit)).toBe(false);
    await store.openFiles([DB]);
    expect(store.books.value.has(bereshit)).toBe(true);
    expect(timeline(store.linkState.value).at(-1)!.label).toBe('החזרת הספר "בראשית"');
    store.undo();
    expect(store.books.value.has(bereshit)).toBe(false);
  });

  it("records of another book's library file stay: removing them would delete them from the library on export", async () => {
    const store = makeStore();
    await store.openFiles([BASE, COMM]);
    const file = JSON.stringify([{ line_index_1: 1, heRef_2: "בסיס א", path_2: "בסיס.txt", line_index_2: 2, "Conection Type": "commentary" }], null, 2);
    await store.openFiles([{ path: "פירוש על בסיס_links.json", blob: new Blob([strToU8(file)]) }]);
    expect(store.linkState.value.links.size).toBe(1);
    store.removeBook(key(store, "בסיס"));
    expect(store.linkState.value.links.size).toBe(1);
    expect([...store.linkState.value.links.values()][0]!.status).toBe("existing");
    expect(store.notices.value.at(-1)!.text).toContain("נשאר");
    // the commentary's own file goes with the commentary: forgotten, so the export does not write it (nothing deleted in the library)
    store.undo();
    store.removeBook(key(store, "פירוש על בסיס"));
    expect(store.linkState.value.links.size).toBe(0);
    expect(store.linkState.value.files.has("פירוש על בסיס")).toBe(false);
    store.undo();
    expect(store.linkState.value.files.has("פירוש על בסיס")).toBe(true);
  });

  it("not while a task runs on the open books", async () => {
    const { store } = await withLinks();
    let release!: () => void;
    const running = store.runTask("עבודה", () => new Promise<void>((r) => (release = r)));
    expect(store.removeBook(key(store, "בסיס"))).toBe(false);
    expect(store.notices.value.at(-1)!.kind).toBe("warning");
    release();
    await running;
  });
});
