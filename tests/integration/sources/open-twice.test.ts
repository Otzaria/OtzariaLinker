import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";

/*
 * #22: the same database picked twice became two sources, loaded twice, with every book listed twice in
 * the link dialog. A file is now one source: its identity (name, size, last-modified and the SQLite header,
 * which holds the change counter) decides, a second pick is reported as already open, and closing the
 * source releases the identity. Real schema-7 slice: tests/fixtures/db/seforim-v7-mini.db.
 */
const BYTES = readFileSync("tests/fixtures/db/seforim-v7-mini.db");
const DB = (name = "seforim.db", lastModified = 1_700_000_000_000) => ({ path: name, blob: new File([BYTES], name, { lastModified }) });

describe("SourceRegistry: a file opens once", () => {
  it("the same database picked twice is one source; the second pick reports it as reused", async () => {
    const r = new SourceRegistry();
    const first = await r.open([DB()]);
    expect(first.sources).toHaveLength(1);
    const second = await r.open([DB()]);
    expect(second.sources).toEqual([]);
    expect(second.reused).toHaveLength(1);
    expect(second.reused![0]!.info.id).toBe(first.sources[0]!.info.id);
    expect(second.reused![0]!.books.length).toBe(first.sources[0]!.books.length);
    expect(second.skipped).toEqual([]);
  });

  it("the same database twice in one drop is one source", async () => {
    const r = new SourceRegistry();
    const res = await r.open([DB(), DB()]);
    expect(res.sources).toHaveLength(1);
    expect(res.reused).toHaveLength(1);
  });

  // V7 §1.6 / #42 C29: this test said the opposite before — a byte-identical copy under another name (or the same file
  // touched) was loaded as a second source, every book listed twice. The identity is now the content, not the name.
  it("a byte-identical copy under another name, or with another last-modified time, is the same database", async () => {
    const r = new SourceRegistry();
    const first = await r.open([DB()]);
    const copy = await r.open([DB("copy.db")]);
    expect(copy.sources).toEqual([]);
    expect(copy.reused![0]!.info.id).toBe(first.sources[0]!.info.id);
    expect(copy.reused![0]!.as).toBe("copy.db");
    expect((await r.open([DB("seforim.db", 1_800_000_000_000)])).sources).toEqual([]);
  });

  it("the same name and size with other content is another database, also when only the middle differs", async () => {
    const r = new SourceRegistry();
    await r.open([DB()]);
    const other = new Uint8Array(BYTES);
    const mid = Math.floor(other.length / 2);
    other[mid] = (other[mid]! + 1) & 0xff; // not in the header, not in the first or the last page
    expect((await r.open([{ path: "seforim.db", blob: new File([other], "seforim.db", { lastModified: 1_700_000_000_000 }) }])).sources).toHaveLength(1);
  });

  it("a plain Blob (no last-modified) is identified by name, size and header", async () => {
    const r = new SourceRegistry();
    await r.open([{ path: "a/seforim.db", blob: new Blob([BYTES]) }]);
    const again = await r.open([{ path: "b/seforim.db", blob: new Blob([BYTES]) }]);
    expect(again.sources).toEqual([]);
    expect(again.reused).toHaveLength(1);
    // the same name and size with another header (the file change counter) is not the same file
    const other = new Uint8Array(BYTES);
    other[27] = (other[27]! + 1) & 0xff;
    expect((await r.open([{ path: "seforim.db", blob: new Blob([other]) }])).sources).toHaveLength(1);
  });

  it("two overlapping drops of the same file open it once (the later one reports it as reused)", async () => {
    const r = new SourceRegistry();
    const [a, b] = await Promise.all([r.open([DB()]), r.open([DB()])]);
    expect(a.sources.length + b.sources.length).toBe(1);
    expect((a.reused?.length ?? 0) + (b.reused?.length ?? 0)).toBe(1);
    const id = (a.sources[0] ?? b.sources[0])!.info.id;
    r.close(id);
    expect((await r.open([DB()])).sources).toHaveLength(1); // closing the one source released the one identity
  });

  it("closing a source releases its identity: the file can be opened again", async () => {
    const r = new SourceRegistry();
    const first = await r.open([DB()]);
    r.close(first.sources[0]!.info.id);
    const again = await r.open([DB()]);
    expect(again.sources).toHaveLength(1);
    expect(again.reused).toBeUndefined();
  });
});

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

describe("AppStore: no duplicate sources, no duplicate books", () => {
  it("opening the same database twice keeps one source and one entry per book", async () => {
    const store = makeStore();
    await store.openFiles([DB()]);
    const books = store.books.value.size;
    expect(store.sources.value).toHaveLength(1);
    await store.openFiles([DB()]);
    expect(store.sources.value).toHaveLength(1);
    expect(store.books.value.size).toBe(books);
    expect(store.lastOpen.added).toEqual([]);
    expect(store.lastOpen.reused).toEqual([store.sources.value[0]!.info.id]);
    expect(store.notices.value.some((m) => m.text.includes("כבר פתוח"))).toBe(true);
  });

  it("a source the worker holds but the store does not know (its open was cancelled late) is adopted when the file is picked again", async () => {
    const reg = new SourceRegistry();
    const service = { open: (f) => reg.open(f), close: async (id) => reg.close(id), lines: (k, a, b) => reg.lines(k, a, b), existingLinks: (k, a, b) => reg.existingLinks(k, a, b), altToc: (k) => reg.altToc(k), headings: (k) => reg.headings(k) } as BooksService;
    const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
    await reg.open([DB()]); // the worker added it; the store never heard
    await store.openFiles([DB()]);
    expect(store.sources.value).toHaveLength(1);
    expect(store.lastOpen.added).toHaveLength(1);
    expect(store.books.value.size).toBeGreaterThan(0);
  });

  it("a source is not closed while a task runs on the sources", async () => {
    const store = makeStore();
    await store.openFiles([DB()]);
    const id = store.sources.value[0]!.info.id;
    let release!: () => void;
    const busy = store.runTask("עבודה", () => new Promise<void>((res) => (release = res)));
    expect(await store.closeSource(id)).toBe(false);
    expect(store.sources.value).toHaveLength(1);
    expect(store.notices.value.some((m) => m.text.includes("בשימוש"))).toBe(true);
    release();
    await busy;
    expect(await store.closeSource(id)).toBe(true);
    expect(store.sources.value).toHaveLength(0);
  });
});
