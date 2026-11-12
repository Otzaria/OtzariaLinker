import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";

/*
 * Which links file stands for a book's LIBRARY file, and when the export may replace the library's
 * file with it (security review A1–A3, compatibility review "new file" suspicion). End to end without
 * UI, on the real schema-7 slice. The records are real: pninimToOtzaria/links/ארצות החיים_links.json
 * in Otzaria/otzaria-library @aa2c293b (the first produced database link 13469515).
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
  return new AppStore(service, { save: () => {} }, loadPreferences(null));
}
const DB = () => ({ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) });
const REC = { line_index_1: 323, heRef_2: "המאיר לארץ על ארצות החיים, סימן יא, סעיף ד ס\"ק יח", path_2: "המאיר לארץ על ארצות החיים.txt", line_index_2: 1307, start: 33, "Conection Type": "commentary" };
const OTHER = { ...REC, heRef_2: "המאיר לארץ על ארצות החיים, סימן יא, סעיף ד ס\"ק יט", line_index_2: 1309, start: 55 };
const BOOK = "ארצות החיים";
const FILE = `${BOOK}_links.json`;

async function opened() {
  const store = makeStore();
  await store.openFiles([DB()]);
  const arzot = [...store.books.value.values()].find((b) => b.title === BOOK)!;
  store.showBook("source", arzot.key);
  store.dbLinks.side.value = "source";
  return store;
}
async function copyOneDbLink(store: AppStore) {
  await store.dbLinks.loadPage();
  const dbl = store.dbLinks.list.value!.links.find((l) => !l.id.endsWith(":link:13469515"))!;
  expect(await store.dbLinks.adopt([dbl])).toBe(1);
}
const codes = (plan: { heldBack: { problems: { code: string }[] }[] }) => [...new Set(plan.heldBack.flatMap((h) => h.problems.map((p) => p.code)))];

describe("A1: a spreadsheet or records file is NEW links, never the book's library file", () => {
  const mapped = (store: AppStore, path: string, text: string) => {
    store.exchange.offerRecords(path, text);
    const p = store.exchange.pendingRecords.value[0]!;
    store.exchange.importRecords({ ...p.mapping, source: { field: "book" }, sourceLine: "from", targetTitle: "to_book", targetLine: "to", type: { field: "kind" } });
  };

  it("records import: provenance import, status new; the db-copy rule still holds the book; nothing counts as kept", async () => {
    const store = await opened();
    mapped(store, "my-links.json", JSON.stringify([{ book: BOOK, from: 5, to_book: "המאיר לארץ על ארצות החיים", to: 7, kind: "commentary" }]));
    expect(store.allLinks.value.map((l) => [l.provenance, l.status, l.fileIndex])).toEqual([["import", "new", undefined]]);
    expect(store.dbLinks.linksFile(BOOK)).toBe("missing");
    await copyOneDbLink(store);
    const plan = (await store.exchange.prepareExport())!;
    expect(plan.files).toEqual([]); // used to write the book's file with only these 2 records, isNewFile false
    expect(codes(plan)).toContain("export/db-copy-no-file");
    expect(plan.counts.kept).toBe(0);
  });

  it("a sheet row with an error is held back like any new link (it used to be written as an untouched import)", async () => {
    const store = await opened();
    mapped(store, "sheet.csv", `book,from,to_book,to,kind\n${BOOK},999999,המאיר לארץ על ארצות החיים,999999,commentary\n`);
    store.dbLinks.confirmNewFile(BOOK);
    const plan = (await store.exchange.prepareExport())!;
    expect(plan.written).toEqual([]);
    expect(codes(plan)).toContain("export/line-out-of-range");
  });

  it("titles are matched by the generator's normalisation when that names exactly one book (B7)", async () => {
    const store = await opened();
    // the slice's Sefaria commentary is written with an ASCII quote (רש"י על …); the sheet writes gershayim
    const dbTitle = [...store.books.value.values()].map((b) => b.title).find((t) => t.includes('"'))!;
    expect(dbTitle).toBeDefined();
    mapped(store, "s.json", JSON.stringify([{ book: BOOK, from: 5, to_book: dbTitle.replace('"', "״"), to: 7, kind: "reference" }]));
    const l = store.allLinks.value[0]!;
    expect(l.target.book.title).toBe(dbTitle);
    expect(l.target.book.origin).not.toBe("unknown");
  });

  it("a sheet for a book whose library file is loaded neither interleaves with it nor changes its layout", async () => {
    const service = { open: async () => ({ sources: [], documents: [], skipped: [] }), lines: async () => [], existingLinks: async () => [], close: async () => {}, headings: async () => [], altToc: async () => null } as unknown as BooksService;
    const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
    const rec = (l: number) => ({ line_index_1: l, heRef_2: `ב ${l}`, path_2: "ב.txt", line_index_2: l, "Conection Type": "reference" });
    store.exchange.importLinksFile("א_links.json", JSON.stringify([rec(1), rec(2), rec(3)], null, 4) + "\n");
    store.exchange.importLinksCsv("א_links.csv", "line_index_1,heRef_2,path_2,line_index_2,Conection Type\n100,x,ב.txt,100,reference\n200,y,ב.txt,200,reference\n");
    const plan = (await store.exchange.prepareExport())!;
    const f = plan.files[0]!;
    expect(JSON.parse(f.text).map((r: { line_index_1: number }) => r.line_index_1)).toEqual([1, 2, 3, 100, 200]); // was [1, 100, 2, 200, 3]
    expect(f.text.startsWith("[\n    {")).toBe(true); // the library file's 4-space layout is kept
    expect(f.isNewFile).toBe(false);
    expect(plan.counts).toMatchObject({ kept: 3, new: 2 });
  });
});

describe("A2: 'the library file is loaded' follows the undoable state, and only a file that parsed counts", () => {
  for (const how of ["undo", "invalid-json"] as const)
    it(`after ${how}, a copied link still waits for the file`, async () => {
      const store = await opened();
      if (how === "undo") {
        store.exchange.importLinksFile(FILE, JSON.stringify([REC]));
        expect(store.dbLinks.linksFile(BOOK)).toBe("imported");
        store.undo();
        expect(store.allLinks.value).toEqual([]);
      } else store.exchange.importLinksFile(FILE, "[{ truncated download");
      expect(store.dbLinks.linksFile(BOOK)).toBe("missing");
      await copyOneDbLink(store);
      const plan = (await store.exchange.prepareExport())!;
      expect(plan.files).toEqual([]);
      expect(codes(plan)).toContain("export/db-copy-no-file");
    });

  it("redo brings the file back; an empty library file counts as loaded", async () => {
    const store = await opened();
    store.exchange.importLinksFile(FILE, JSON.stringify([REC]));
    store.undo();
    store.redo();
    expect(store.dbLinks.linksFile(BOOK)).toBe("imported");
    const empty = await opened();
    empty.exchange.importLinksFile(FILE, "[]");
    expect(empty.dbLinks.linksFile(BOOK)).toBe("imported");
  });
});

describe("A3: a saved project's copy of a library file is a snapshot until verified", () => {
  const projectWith = (records: object[], change?: (s: AppStore) => void) => {
    const a = makeStore();
    a.exchange.importLinksFile(FILE, JSON.stringify(records));
    change?.(a);
    return a.projectText();
  };

  it("in a new session the book is held (export/file-unverified) — it used to replace the library's file", async () => {
    const store = await opened();
    store.openProject("p.json", projectWith([REC]));
    expect(store.dbLinks.linksFile(BOOK)).toBe("unverified");
    await copyOneDbLink(store);
    const plan = (await store.exchange.prepareExport())!;
    expect(plan.files).toEqual([]);
    expect(codes(plan)).toContain("export/file-unverified");
    // the explicit confirmation lets it through
    store.dbLinks.confirmNewFile(BOOK);
    expect((await store.exchange.prepareExport())!.files.map((f) => f.records)).toEqual([2]);
  });

  it("loading the same library file verifies the snapshot and keeps the project's changes", async () => {
    const lib = JSON.stringify([REC, OTHER]);
    const text = projectWith([REC, OTHER], (a) => a.deleteLinks([a.allLinks.value[1]!.id]));
    const store = await opened();
    store.openProject("p.json", text);
    store.exchange.importLinksFile(FILE, lib);
    expect(store.dbLinks.linksFile(BOOK)).toBe("imported");
    expect(store.allLinks.value.map((l) => l.status)).toEqual(["existing", "deleted"]);
    const plan = (await store.exchange.prepareExport())!;
    expect(plan.files.map((f) => [f.records, f.isNewFile])).toEqual([[1, false]]);
  });

  it("a forged snapshot that claims the library file's fingerprint is replaced by the real file, not verified", async () => {
    const real = JSON.parse(projectWith([REC]));
    const forged = { ...real, links: real.links.map((l: { target: object }) => ({ ...l, target: { ...l.target, line: 5 } })) };
    const store = await opened();
    store.openProject("p.json", JSON.stringify(forged));
    store.exchange.importLinksFile(FILE, JSON.stringify([REC]));
    expect(store.dbLinks.linksFile(BOOK)).toBe("imported");
    expect(store.allLinks.value.map((l) => l.target.line)).toEqual([1306]);
  });

  it("a different library file is not merged into a snapshot the user changed", async () => {
    const text = projectWith([REC], (a) => a.setType([a.allLinks.value[0]!.id], "reference"));
    const store = await opened();
    store.openProject("p.json", text);
    store.exchange.importLinksFile(FILE, JSON.stringify([REC, OTHER]));
    expect(store.dbLinks.linksFile(BOOK)).toBe("unverified");
    expect(store.allLinks.value).toHaveLength(1);
    expect(store.notices.value.at(-1)!.kind).toBe("error");
  });
});

describe("A3: a new link of a book the database says has links waits for the book's library file", () => {
  it("export/library-file-not-loaded holds the file until it is loaded or the user confirms", async () => {
    const book = (key: string, title: string, extra = {}) => ({ key, title, origin: "otzaria", lineCount: 10, ...extra });
    const service = {
      open: async () => ({ sources: [{ info: { id: "s1", kind: "otzaria-db", label: "seforim.db", warnings: [] }, books: [book("s1:1", "א", { hasSourceLinks: true }), book("s1:2", "ב")] }], documents: [], skipped: [] }),
      lines: async (_k: string, a: number, b: number) => Array.from({ length: Math.min(b, 9) - a + 1 }, (_, i) => ({ index: a + i, text: "x", anchorText: "x", heRef: null, heading: null, existsInDb: true })),
      existingLinks: async () => [],
      close: async () => {},
      headings: async () => [],
      altToc: async () => null,
    } as unknown as BooksService;
    const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
    await store.openFiles([{ path: "seforim.db", blob: new Blob([]) }]);
    store.pickLine("source", "s1:1", 1);
    store.pickLine("target", "s1:2", 2);
    store.draftType.value = "reference";
    store.draftTypeTouched.value = true;
    expect(store.createFromDraft()).not.toBeNull();
    let plan = (await store.exchange.prepareExport())!;
    expect(plan.files).toEqual([]);
    expect(codes(plan)).toEqual(["export/library-file-not-loaded"]);
    store.dbLinks.confirmNewFile("א");
    plan = (await store.exchange.prepareExport())!;
    expect(plan.files.map((f) => [f.name, f.isNewFile])).toEqual([["א_links.json", true]]);
  });
});
