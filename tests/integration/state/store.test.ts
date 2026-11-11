import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";

function makeStore() {
  const reg = new SourceRegistry();
  const service: BooksService = {
    open: (f) => reg.open(f),
    lines: (k, a, b) => reg.lines(k, a, b),
    existingLinks: (k, a, b) => reg.existingLinks(k, a, b),
    close: async (id) => reg.close(id),
  };
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(service, { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  return { store, saved };
}
const DB = { path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) };
const COMMENTARY = { path: "פירוש על בראשית.txt", blob: new Blob([strToU8("<h1>פירוש על בראשית</h1>\nבראשית - פירוש ראשון\nויאמר - פירוש שני")]) };

describe("AppStore — the manual linking flow end to end (without UI)", () => {
  it("open → pick → create → undo/redo → export", async () => {
    const { store, saved } = makeStore();
    await store.openFiles([DB, COMMENTARY]);
    expect(store.screen.value).toBe("workspace");
    const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    const comm = [...store.books.value.values()].find((b) => b.title === "פירוש על בראשית")!;

    await store.lines.load(bereshit.key, 0, 10);
    await store.lines.load(comm.key, 0, 2);
    const verse = [0, 1, 2, 3, 4, 5].find((i) => store.lines.peek(bereshit.key, i)!.heading === null)!;

    store.pickLine("source", comm.key, 1);
    store.pickLine("target", bereshit.key, verse);
    expect(store.draftProblems.value.map((p) => p.code)).toContain("sefaria/ref2-required"); // Bereshit is a Sefaria book
    store.draftRef2.value = "Genesis 1:1";
    expect(store.draft.value).toMatchObject({ declaredType: "commentary", source: { line: 1 }, target: { line: verse } });
    expect(store.draft.value!.heRef2).toBe(store.lines.peek(bereshit.key, verse)!.heRef);

    const link = store.createFromDraft()!;
    expect(link).toMatchObject({ status: "new", provenance: "user" });
    expect(store.pick.source.value).toEqual({ bookKey: comm.key, line: 2 }); // advances to the next line
    expect(store.dirty.value).toBe(true);

    store.undo();
    expect(store.allLinks.value).toEqual([]);
    store.redo();
    expect(store.allLinks.value).toHaveLength(1);

    const plan = (await store.prepareExport())!;
    expect(plan.counts).toMatchObject({ new: 1, heldBack: 0, files: 1 });
    store.saveExport(plan);
    expect(saved[0]!.name).toBe("פירוש על בראשית_links.json");
    expect(JSON.parse(saved[0]!.data as string)[0]).toMatchObject({ line_index_1: 2, path_2: "בראשית.txt", line_index_2: verse + 1, "Conection Type": "commentary" });
    expect(store.dirty.value).toBe(false);
  });

  it("a link to a heading line is refused, with the reason", async () => {
    const { store } = makeStore();
    await store.openFiles([DB, COMMENTARY]);
    const bereshit = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    const comm = [...store.books.value.values()].find((b) => b.title === "פירוש על בראשית")!;
    await store.lines.load(bereshit.key, 0, 5);
    await store.lines.load(comm.key, 0, 2);
    store.pickLine("source", comm.key, 1);
    store.pickLine("target", bereshit.key, 0); // <h1>בראשית</h1>
    expect(store.draftProblems.value.map((p) => p.code)).toContain("export/heading-line");
    expect(store.createFromDraft()).toBeNull();
  });

  it("an imported links file binds to books opened later by exact title, and re-exports unchanged", async () => {
    const { store, saved } = makeStore();
    const text = JSON.stringify([{ line_index_1: 2, heRef_2: "בראשית א, א", path_2: "בראשית.txt", line_index_2: 3, "Conection Type": "commentary" }], null, 2);
    await store.openFiles([{ path: "פירוש על בראשית_links.json", blob: new Blob([strToU8(text)]) }]);
    expect(store.allLinks.value[0]!.source.book.origin).toBe("unknown");
    await store.openFiles([DB, COMMENTARY]);
    const comm = [...store.books.value.values()].find((b) => b.title === "פירוש על בראשית")!;
    expect(store.linksOfBook(comm.key)).toHaveLength(1);
    const plan = (await store.prepareExport())!;
    expect(plan.heldBack).toEqual([]);
    store.saveExport(plan);
    expect(saved[0]!.data).toBe(text);
  });

  it("delete of an imported link marks it; export drops it; undo brings it back", async () => {
    const { store } = makeStore();
    const text = JSON.stringify([{ line_index_1: 2, heRef_2: "x", path_2: "בראשית.txt", line_index_2: 3, "Conection Type": "commentary" }], null, 2);
    await store.openFiles([DB, COMMENTARY, { path: "פירוש על בראשית_links.json", blob: new Blob([strToU8(text)]) }]);
    const id = store.allLinks.value[0]!.id;
    store.deleteLinks([id]);
    expect(store.linkState.value.links.get(id)!.status).toBe("deleted");
    expect((await store.prepareExport())!.counts.deleted).toBe(1);
    store.undo();
    expect(store.linkState.value.links.get(id)!.status).toBe("existing");
  });
});
