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

/*
 * What still pointed at a book after it left the tool (V7 round-2 review, finding 2): the suggestion run on the screen,
 * the edition comparison, the heading search. A run touching the book is dropped (like workerLost): approving one of
 * its suggestions would make a link to a book the user removed. Undo of the removal brings the book and its links
 * back, not the run: the user runs it again (USER_GUIDE "הסרת ספר").
 */
describe("removing a book: nothing left that points at it (V7 round-2 review, finding 2)", () => {
  const DB = () => ({ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) });
  const HEB = ["א", "ב", "ג", "ד", "ה"];
  const BIUR = () => ({ path: "ביאור על בראשית.txt", blob: new Blob([strToU8(["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])].join("\n"))]) });
  async function ran() {
    const store = makeStore();
    await store.openFiles([DB(), BIUR()]);
    expect(await store.suggestions.runEngine("headings", key(store, "ביאור על בראשית"), key(store, "בראשית"))).toBe(true);
    expect(store.suggestions.pendingAtLeast("certain").length).toBeGreaterThan(0);
    return store;
  }

  it("a run that touches the removed book is dropped, and nothing of it can be approved; undo brings the book back, not the run", async () => {
    const store = await ran();
    const ids = store.suggestions.pendingAtLeast("certain");
    const bereshit = key(store, "בראשית");
    expect(store.removeBook(bereshit)).toBe(true);
    expect(store.suggestions.run.value).toBeNull();
    expect(store.suggestions.current.value).toBeNull();
    expect(store.suggestions.approve(ids)).toBe(0);
    expect(store.allLinks.value).toEqual([]);
    expect(store.notices.value.at(-1)!.text).toContain("ההצעות");
    store.undo();
    expect(store.books.value.has(bereshit)).toBe(true);
    expect(store.suggestions.run.value).toBeNull();
  });

  it("a run that does not touch the removed book stays", async () => {
    const store = await ran();
    await store.openFiles([OTHER]);
    const run = store.suggestions.run.value;
    expect(store.removeBook(key(store, "אחר"))).toBe(true);
    expect(store.suggestions.run.value).toBe(run);
  });

  it("approve refuses a suggestion whose book is not open, and says why (defence in depth)", async () => {
    const store = await ran();
    const run = store.suggestions.run.value!;
    const ids = store.suggestions.pendingAtLeast("certain");
    store.removeBook(key(store, "בראשית"));
    // a run kept from before (any path that missed the removal): its suggestions name a book that is not open
    store.suggestions.run.value = run;
    expect(store.suggestions.approve(ids)).toBe(0);
    expect(store.allLinks.value).toEqual([]);
    expect(store.notices.value.at(-1)!.kind).toBe("warning");
    expect(store.notices.value.at(-1)!.text).toContain("בראשית");
  });

  it("closing the source of a book of the run drops the run too", async () => {
    const store = await ran();
    const dbId = store.sources.value.find((s) => s.books.some((b) => b.title === "בראשית"))!.info.id;
    expect(await store.closeSource(dbId)).toBe(true);
    expect(store.suggestions.run.value).toBeNull();
    expect(store.suggestions.current.value).toBeNull();
  });

  it("the edition comparison of a removed book is dropped: its plan would move links to a book that is not open", async () => {
    const store = makeStore();
    await store.openFiles([BASE]);
    await store.openFiles([txt("בסיס.txt", ["<h1>בסיס</h1>", "שורה ראשונה", "שורה חדשה", "שורה שנייה", "שורה שלישית"])]);
    const [oldKey, newKey] = [...store.books.value.values()].filter((b) => b.title === "בסיס").map((b) => b.key);
    expect(newKey).toBeDefined();
    expect(await store.planRelinkFor(oldKey!, newKey!)).toBe(true);
    expect(store.relink.value).not.toBeNull();
    store.removeBook(newKey!);
    expect(store.relink.value).toBeNull();
  });

  it("the heading search does not answer with a removed book", async () => {
    const store = makeStore();
    await store.openFiles([BASE, OTHER]);
    expect(await store.headingSearch.build("light")).toBe(true);
    expect(store.headingSearch.search("בסיס", "light").hits.map((h) => h.title)).toContain("בסיס");
    store.removeBook(key(store, "בסיס"));
    expect(store.headingSearch.search("בסיס", "light").hits).toEqual([]);
  });
});
