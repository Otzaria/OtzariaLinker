import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { registryService } from "../../support/books-service";

/* Coverage through the store (issue #17): the real database slice plus a commentary of text lines; approve, undo, delete. */
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const heb = (n: number) => ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"][n]!;
const COMMENTARY = { path: "ביאור על בראשית.txt", blob: new Blob([strToU8(["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 10 }, (_, i) => [`<h3>פסוק ${heb(i + 1)}</h3>`, `ביאור לפסוק ${i + 1}`]).flat(), "<h2>פרק ב</h2>", "שורה בלי כותרת פסוק"].join("\n"))]) };

async function opened() {
  const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
  await store.openFiles([DB, COMMENTARY]);
  const key = (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key;
  return { store, key };
}

describe("AppStore — coverage", () => {
  it("before any link: every suitable line is unlinked, the headings are not suitable", async () => {
    const { store, key } = await opened();
    const s = (await store.coverage.summary(key("ביאור על בראשית")))!;
    expect(s.total).toBe(24);
    expect(s.byBucket).toMatchObject({ linked: 0, partial: 0, multiple: 0, "not-suitable": 13 });
    expect(s.unlinked).toBe(11);
    expect(s.unlinkedShare).toBe(1);
    // the verse lines, between the verse headings (each pair is one range), and the last line
    expect(s.ranges[0]).toEqual({ start: 3, end: 3 });
    expect(s.ranges.at(-1)).toEqual({ start: 23, end: 23 });
  });

  it("approving links moves lines out of 'unlinked'; undo brings them back", async () => {
    const { store, key } = await opened();
    const scope = { kind: "book", key: key("ביאור על בראשית") } as const;
    expect(await store.maxLink.run(store.maxLink.plan(scope, new Set(["headings"])), store.maxLink.scopeLabel(scope))).toBe(true);
    const certain = store.suggestions.pendingAtLeast("certain");
    expect(certain.length).toBe(10);
    store.suggestions.approve(certain);
    const after = (await store.coverage.summary(key("ביאור על בראשית")))!;
    expect(after.byBucket.linked).toBe(10);
    expect(after.unlinked).toBe(1); // the last line, under a chapter heading with no verse heading
    store.undo();
    expect((await store.coverage.summary(key("ביאור על בראשית")))!.unlinked).toBe(11);
  });

  it("a book that is not open has no coverage", async () => {
    const { store } = await opened();
    expect(await store.coverage.summary("ghost:1")).toBeNull();
  });
});
