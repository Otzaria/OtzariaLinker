import { describe, expect, it } from "vitest";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";

/*
 * Compatibility review B2/B3 through the builder: an edited record drops the weekly sync's stale fields,
 * and no path writes a blank heRef_2. A fake service: two books, lines with a blank heRef.
 */
function storeWith() {
  const book = (key: string, title: string, origin: string) => ({ key, title, origin, lineCount: 20 });
  const service = {
    open: async () => ({ sources: [{ info: { id: "s1", kind: "otzaria-db", label: "db", warnings: [] }, books: [book("s1:1", "משנה ברורה", "sefaria"), book("s1:2", "שער הציון", "otzaria")] }], documents: [], skipped: [] }),
    lines: async (_k: string, a: number, b: number) => Array.from({ length: Math.min(b, 19) - a + 1 }, (_, i) => ({ index: a + i, text: "שורה של טקסט", anchorText: "שורה של טקסט", heRef: "  ", heading: null, existsInDb: true })),
    existingLinks: async () => [],
    close: async () => {},
    headings: async () => [],
    altToc: async () => null,
  } as unknown as BooksService;
  return new AppStore(service, { save: () => {} }, loadPreferences(null));
}
const SYNCED = { line_index_1: 5, ref_1: "Mishnah Berurah,  1:1", anchor_src_hash: "sha256:abc", anchor_context: { before: "x", after: "y" }, heRef_2: "שער הציון א", path_2: "שער הציון.txt", line_index_2: 3, start: 4, "Conection Type": "commentary" };

describe("editing a record the weekly sync enriched (B2)", () => {
  it("moving the source line drops ref_1, anchor_src_hash and anchor_context, and says so", async () => {
    const store = storeWith();
    await store.openFiles([{ path: "db", blob: new Blob([]) }]);
    store.exchange.importLinksFile("משנה ברורה_links.json", JSON.stringify([SYNCED]));
    const l = store.allLinks.value[0]!;
    store.editInBuilder(l.id);
    expect(store.draft.value!.passthrough).toMatchObject({ anchor_src_hash: "sha256:abc" });
    store.pickLine("source", "s1:1", 8);
    const d = store.draft.value!;
    expect(d.ref1).toBeUndefined();
    expect(d.passthrough).toBeUndefined();
    expect(store.draftProblems.value.map((p) => p.code)).toEqual(expect.arrayContaining(["edit/pipeline-fields-dropped", "sefaria/ref1-required"]));
  });
});

describe("heRef_2 is never blank (B3)", () => {
  it("a cleared field and a blank database reference fall back to title and line", async () => {
    const store = storeWith();
    await store.openFiles([{ path: "db", blob: new Blob([]) }]);
    await store.lines.load("s1:2", 0, 10);
    store.pickLine("source", "s1:2", 1);
    store.pickLine("target", "s1:2", 4);
    store.draftHeRef.value = "   ";
    expect(store.draft.value!.heRef2).toBe("שער הציון 5");
  });
});
