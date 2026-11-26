import { describe, expect, it } from "vitest";
import type { SourceBook, SourceLine } from "../../../src/core/books";
import type { BookRef, Link } from "../../../src/core/links/model";
import { addChanges, commit } from "../../../src/state/history";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, OpenedSource } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";

/*
 * V7 §4.10 (docs/validation/V7_V52_VALIDATION.md §6): 45,000 approved links from v52 commentaries into Sefaria books of seforim.db —
 * 44,453 held back for a submission with "sefaria/ref2-required", although every line had its heRef. The export fills ref_2 from the
 * line's heRef, but it read the heRef from the views' bounded line cache (400 chunks): the check had read every line, and the first
 * ones were gone by the time the refs were filled. The heRef is kept with the line facts the check reads (review C7 kept the rest).
 *
 * Two books of 200,000 lines; 500 links from the commentary into "בראשית" (a Sefaria book), every target in its own chunk.
 */
const N = 200_000;
const books: SourceBook[] = [
  { key: "s1:1", title: "ביאור על בראשית", origin: "otzaria", lineCount: N },
  { key: "s1:2", title: "בראשית", origin: "sefaria", lineCount: N },
];
const line = (key: string, index: number): SourceLine => ({ index, text: `שורה ${index}`, anchorText: `שורה ${index}`, heRef: key === "s1:2" ? "בראשית, א, א" : null, heading: null, existsInDb: true });
const service = {
  open: async (): Promise<{ sources: OpenedSource[]; documents: []; skipped: [] }> => ({ sources: [{ info: { id: "s1", kind: "otzaria-db", label: "x.db", warnings: [], library: true }, books }], documents: [], skipped: [] }),
  lines: async (key: string, from: number, to: number) => Array.from({ length: Math.min(to, N - 1) - from + 1 }, (_, i) => line(key, from + i)),
  existingLinks: async () => [],
} as unknown as BooksService;
const ref = (b: SourceBook): BookRef => ({ key: b.key, title: b.title, origin: b.origin });
const link = (k: number): Link => ({
  id: `u:${k}`,
  status: "new",
  provenance: "auto",
  source: { book: ref(books[0]!), line: 400 * k + 5 },
  target: { book: ref(books[1]!), line: 400 * k + 9 },
  declaredType: "commentary",
  heRef2: "בראשית",
});

describe("ref_2 of a submission on more chunks than the cache holds (V7 §4.10)", () => {
  it("every link into the Sefaria book gets its ref_2 from its line's heRef; none is held back", async () => {
    const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
    await store.openFiles([{ path: "x.db", blob: new Blob([]) }]);
    expect(store.isSefariaOwned({ title: "בראשית", key: "s1:2" })).toBe(true);
    const links = Array.from({ length: 500 }, (_, k) => link(k));
    store.linkState.value = commit(store.linkState.value, "test", addChanges(links));
    expect(store.exportPurpose.value).toBe("submission");

    const qa = (await store.quality.run())!;
    expect(qa.issues.filter((i) => i.problem.code === "sefaria/ref2-required")).toHaveLength(0);
    const plan = (await store.exchange.prepareExport())!;
    expect(plan.heldBack.filter((h) => h.problems.some((p) => p.code === "sefaria/ref2-required"))).toHaveLength(0);
    expect(store.allLinks.value.filter((l) => l.ref2 === "Genesis 1:1")).toHaveLength(500);
  });

  it("the links table's bulk \"fix the Sefaria refs\" fills every one of them too", async () => {
    const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
    await store.openFiles([{ path: "x.db", blob: new Blob([]) }]);
    const links = Array.from({ length: 500 }, (_, k) => link(k));
    store.linkState.value = commit(store.linkState.value, "test", addChanges(links));
    expect(await store.fixes.fixRefs(links.map((l) => l.id))).toBe(500);
    expect(store.allLinks.value.filter((l) => l.ref2 === "Genesis 1:1")).toHaveLength(500);
  });
});
