import { readFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";

/*
 * What the export writes into the library must be what the library had plus what the user did —
 * never more, never less (security review of OtzariaLinker 2.0, findings A1–A4). End to end without UI,
 * on the real schema-7 slice.
 */
function makeStore() {
  const reg = new SourceRegistry();
  const service = {
    open: (f) => reg.open(f),
    openMapped: (t, m) => reg.openMapped(t, m),
    lines: (k, a, b) => reg.lines(k, a, b),
    existingLinks: (k, a, b) => reg.existingLinks(k, a, b),
    close: async (id) => reg.close(id),
    altToc: (k) => reg.altToc(k),
    headings: (k) => reg.headings(k),
    dbLinkSummary: (k, opts) => reg.dbLinkSummary(k, { ...(opts?.signal && { signal: opts.signal }) }),
    dbLinksPage: (k, query) => reg.dbLinksPage(k, query),
  } as BooksService;
  const saved: { name: string; data: Uint8Array | string }[] = [];
  const store = new AppStore(service, { save: (name, data) => saved.push({ name, data }) }, loadPreferences(null));
  return { store, saved };
}
const DB = () => ({ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) });

describe("A4: a book title never becomes a path outside the export folder", () => {
  it("a project with titles like ../../x exports nothing under those names", async () => {
    const { store, saved } = makeStore();
    const link = (title: string, i: number) => ({ id: `u${i}`, status: "new", provenance: "user", source: { book: { title, origin: "personal" }, line: 0 }, target: { book: { title: "ב", origin: "personal" }, line: 0 }, declaredType: "reference", heRef2: "ב 1" });
    const real = JSON.parse(store.projectText());
    const project = { ...real, links: [link("../../../.github/workflows/x", 1), link("..\\..\\Startup\\y", 2), link("א", 3), link("ג", 4)] };
    store.openProject("p.json", JSON.stringify(project));
    const plan = (await store.prepareExport())!;
    expect(plan.heldBack.map((h) => h.link.source.book.title).sort()).toEqual(["../../../.github/workflows/x", "..\\..\\Startup\\y"].sort());
    expect(plan.heldBack.every((h) => h.problems.some((p) => p.code === "export/unsafe-title"))).toBe(true);
    store.saveExport(plan);
    const zip = saved.find((s) => s.name.endsWith(".zip"))!;
    expect(Object.keys(unzipSync(zip.data as Uint8Array)).sort()).toEqual(["_report.txt", "links/א_links.json", "links/ג_links.json"]);
  });
});


describe("A7: one failing document of a drop does not lose the others", () => {
  it("a document that throws is a notice; the rest are imported", async () => {
    const service = {
      open: async () => ({
        sources: [],
        skipped: [],
        documents: [
          { kind: "alt-toc-json", path: "ספר_alt_toc.json", text: "[]" },
          { kind: "links-json", path: "א_links.json", text: JSON.stringify([{ line_index_1: 1, heRef_2: "ב 1", path_2: "ב.txt", line_index_2: 1, "Conection Type": "reference" }]) },
        ],
      }),
      lines: async () => [],
      existingLinks: async () => [],
      close: async () => {},
      headings: async () => [],
      altToc: async () => null,
    } as unknown as BooksService;
    const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
    store.altToc.importFile = () => {
      throw new RangeError("Maximum call stack size exceeded");
    };
    await store.openFiles([{ path: "x", blob: new Blob([]) }]);
    expect(store.allLinks.value).toHaveLength(1);
    expect(store.notices.value.some((n) => n.kind === "error" && n.text.includes("ספר_alt_toc.json"))).toBe(true);
  });
});
