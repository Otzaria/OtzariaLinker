import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/*
 * Version 3's global heading index (F-139): the headings of many books searched at once, a result opens the book at
 * the heading. Two scopes, as in version 3: the books the user works on, or every open book (a whole database).
 */
function makeStore() {
  return new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
}
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const NOTES = { path: "הערות על בראשית.txt", blob: new Blob([strToU8(["<h1>הערות על בראשית</h1>", "<h2>פרק ראשון</h2>", "הערה", "<h2>פרק שני</h2>", "הערה"].join("\n"))]) };

describe("searching the headings of many books (V7 parity F-139)", () => {
  it("the light scope reads the files' books and the books in use, never the whole database", async () => {
    const store = makeStore();
    await store.openFiles([DB, NOTES]);
    const hs = store.headingSearch;
    const notes = [...store.books.value.values()].find((b) => b.title === "הערות על בראשית")!;
    const light = hs.booksOf("light");
    expect(light).toContain(notes.key);
    expect(light.length).toBeLessThan(hs.booksOf("all").length);
    expect(await hs.build("light")).toBe(true);
    // every word must appear, in the heading or in the book's title
    const { hits } = hs.search("הערות שני", "light");
    expect(hits).toEqual([{ key: notes.key, title: "הערות על בראשית", line: 3, level: 2, text: "פרק שני" }]);
    expect(hs.search("פרק שלישי", "light").hits).toEqual([]);
    expect(hs.status.value).toMatchObject({ scope: "light", read: light.length });
  });

  it("the full scope reads every open book, with the task's progress; a hit opens the book at the heading", async () => {
    const store = makeStore();
    await store.openFiles([DB, NOTES]);
    const hs = store.headingSearch;
    expect(await hs.build("all")).toBe(true);
    const { hits } = hs.search("בראשית", "all");
    const inDb = hits.find((h) => h.title === "בראשית");
    expect(inDb).toBeDefined();
    store.reveal("source", inDb!.key, inDb!.line);
    expect(store.view.source.value).toBe(inDb!.key);
    expect(store.focus.source.value!.line).toBe(inDb!.line);
  });

  it("at most 300 results, and says there are more", async () => {
    const store = makeStore();
    const many = { path: "ספר ארוך.txt", blob: new Blob([strToU8(Array.from({ length: 400 }, (_, i) => `<h2>סימן ${i + 1}</h2>\nטקסט`).join("\n"))]) };
    await store.openFiles([many]);
    await store.headingSearch.build("light");
    const r = store.headingSearch.search("סימן", "light");
    expect(r.hits).toHaveLength(300);
    expect(r.more).toBe(true);
  });
});
