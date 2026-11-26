import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { cachedCitationBooks } from "../../../src/workers/citations-job";
import { registryService } from "../../support/books-service";

/*
 * V7 round 2, item 10 (docs/reviews/V7_PERFORMANCE.md §9.4): the citations engine keeps the indexes of the books it resolved into
 * (by book key, up to 400,000 lines) for the next run. After the database closed they were never asked again — a source opened again
 * gets new keys — yet stayed: on seforim.db ~240 MB of the heap after a 10-book max-link run, when everything else was released.
 * Closing a source releases what the caches hold for its books; the other sources' entries stay.
 */
const DB = () => ({ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) });
const LINES = ["<h1>ספר דוגמה</h1>", "כמו שנאמר (בראשית א, א) בפסוק הראשון", "וכן מבואר בבראשית א ב בהמשך הדברים"];
const TEXT = () => ({ path: "ספר דוגמה.txt", blob: new Blob([strToU8(LINES.join("\n"))]) });

describe("the citations caches forget a closed source's books", () => {
  it("after a citations run into the database, closing the database leaves nothing of its books in the caches", async () => {
    const registry = new SourceRegistry();
    const store = new AppStore(registryService(registry), { save: () => {} }, loadPreferences(null));
    await store.openFiles([DB(), TEXT()]);
    const [db, text] = [store.sources.value.find((s) => s.info.kind === "otzaria-db")!, store.sources.value.find((s) => s.info.kind !== "otzaria-db")!];
    const book = text.books[0]!.key;
    expect(await store.suggestions.runCitations(book, { citationType: "reference" })).toBe(true);
    expect(store.suggestions.run.value!.result.suggestions.some((s) => s.target.book.title === "בראשית")).toBe(true);
    // the run cached the index of בראשית, a book of the database
    expect(cachedCitationBooks(registry).filter((k) => k.startsWith(`${db.info.id}:`)).length).toBeGreaterThan(0);

    await store.closeSource(db.info.id);
    expect(cachedCitationBooks(registry).filter((k) => k.startsWith(`${db.info.id}:`))).toEqual([]);
    // the text source is still open and its run still works (the catalog is built again from what is open)
    expect(await store.suggestions.runCitations(book, { citationType: "reference" })).toBe(true);
  });
});
