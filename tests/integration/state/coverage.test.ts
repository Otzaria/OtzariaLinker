import { readFileSync } from "node:fs";
import { signal } from "@preact/signals";
import { strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { CoverageState, type CoverageHost } from "../../../src/state/coverage";
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

describe("coverage table of many books (the repository screen)", () => {
  async function dbStore() {
    const service = registryService(new SourceRegistry());
    const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
    await store.openFiles([DB]);
    const keys = [...store.books.value.values()].map((b) => b.key);
    return { store, service, keys, key: (t: string) => [...store.books.value.values()].find((b) => b.title === t)!.key };
  }
  const collect = async (it: AsyncIterable<{ title: string }>) => {
    const rows = [];
    for await (const r of it) rows.push(r);
    return rows;
  };

  it("one row per book with its buckets, read from the database's link indexes — Onkelos is linked to Bereshit there", async () => {
    const { store, keys, key } = await dbStore();
    const rows = (await collect(store.coverage.rows(keys))) as Awaited<ReturnType<typeof store.coverage.table>>;
    expect(rows.map((r) => r.title).sort()).toEqual([...store.books.value.values()].map((b) => b.title).sort());
    const onk = rows.find((r) => r.key === key("תרגום אונקלוס על בראשית"))!;
    expect(onk.counts.byBucket.linked).toBeGreaterThan(100);
    // no headings and no text were read: the row says it is approximate
    expect(onk.exact).toBe(false);
    expect(rows.every((r) => r.counts.total === r.lineCount)).toBe(true);
  });

  it("with headings: they are not suitable, and the row is exact about them", async () => {
    const { store, key } = await dbStore();
    const [row] = await store.coverage.table([key("בראשית")], { headings: true });
    const [plain] = await store.coverage.table([key("בראשית")]);
    expect(row!.exact).toBe(true);
    expect(row!.counts.byBucket["not-suitable"]).toBeGreaterThan(plain!.counts.byBucket["not-suitable"]);
  });

  it("is lazy and cancellable: the next book is read only when asked for, and a cancel stops at the next one", async () => {
    const { store, service, keys } = await dbStore();
    // the table reads each book's compact ends (#42 C7, C8), one book per row asked for
    const spy = vi.spyOn(service as Required<typeof service>, "coverageEnds");
    const it = store.coverage.rows(keys)[Symbol.asyncIterator]();
    await it.next();
    expect(spy).toHaveBeenCalledTimes(1);
    await it.next();
    expect(spy).toHaveBeenCalledTimes(2);
    const ctl = new AbortController();
    const seen: string[] = [];
    for await (const r of store.coverage.rows(keys, { signal: ctl.signal })) {
      seen.push(r.key);
      ctl.abort();
    }
    expect(seen).toHaveLength(1);
  });

  it("books the table cannot count (not open) are left out, not zero rows", async () => {
    const { store } = await dbStore();
    expect(await store.coverage.table(["ghost:1"])).toEqual([]);
  });
});

describe("coverage in the project file (2.15)", () => {
  const fresh = () => new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
  it("the last coverage of each book is saved with the project and comes back when it is opened", async () => {
    const a = fresh();
    await a.openFiles([DB, COMMENTARY]);
    const key = [...a.books.value.values()].find((b) => b.title === "ביאור על בראשית")!.key;
    expect(JSON.parse(a.projectText())).not.toHaveProperty("coverage");
    const s = (await a.coverage.summary(key))!;
    const saved = JSON.parse(a.projectText()).coverage;
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: "ביאור על בראשית", lines: s.total, buckets: expect.objectContaining({ unlinked: s.unlinked }) });
    expect(saved[0].ranges).toEqual(s.ranges.map((r) => [r.start, r.end]));
    const b = fresh();
    b.openProject("p.otzlinker.json", a.projectText());
    expect(b.coverage.saved.value.get("ביאור על בראשית")).toMatchObject({ lines: s.total, buckets: { unlinked: s.unlinked } });
    // and it survives being saved again before the books are open
    expect(JSON.parse(b.projectText()).coverage[0].title).toBe("ביאור על בראשית");
  });

  it("a project saved before this existed opens with no coverage", () => {
    const b = fresh();
    b.openProject("old.otzlinker.json", JSON.stringify({ format: "otzaria-linker-project", version: 1, savedAt: "", app: "4.0.0", sources: [], links: [], rejectedSuggestions: [], view: { source: null, target: null } }));
    expect(b.coverage.saved.value.size).toBe(0);
  });
});

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
    // the last line (under a chapter heading with no verse heading) has a weaker suggestion pending: found, not approved
    expect(after.byBucket).toMatchObject({ candidate: 1, unlinked: 0 });
    store.undo();
    // the same suggestions are pending again: found, not approved (without them, nothing is linked)
    expect((await store.coverage.summary(key("ביאור על בראשית")))!.byBucket).toMatchObject({ candidate: 11, unlinked: 0, linked: 0 });
    expect((await store.coverage.summary(key("ביאור על בראשית"), { includeCandidates: false }))!.unlinked).toBe(11);
  });

  it("blank and one-letter lines are not suitable, so they are not 'unlinked' (QA)", async () => {
    const store = new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
    await store.openFiles([{ path: "פירוש.txt", blob: new Blob([strToU8(["<h1>פירוש</h1>", "", "ביאור ארוך כאן עם מילים", "א", "   ", "ביאור נוסף עם מילים"].join(String.fromCharCode(10)))]) }]);
    const key = [...store.books.value.values()].find((b) => b.title === "פירוש")!.key;
    const s = (await store.coverage.summary(key))!;
    expect(s.byBucket).toMatchObject({ "not-suitable": 4, unlinked: 2 });
    expect(s.ranges).toEqual([{ start: 2, end: 2 }, { start: 5, end: 5 }]);
  });

  it("the links the open database already has count by default: Onkelos is linked to Bereshit there (QA)", async () => {
    const { store, key } = await opened();
    const book = key("תרגום אונקלוס על בראשית");
    const withDb = (await store.coverage.summary(book))!;
    expect(withDb.byBucket.linked).toBeGreaterThan(100);
    // the slice has holes (lines kept only for other links): a line that is not in the book is not "unlinked"
    expect(withDb.unlinkedShare).toBeLessThan(0.1);
    const projectOnly = (await store.coverage.summary(book, { includeDb: false }))!;
    expect(projectOnly.byBucket.linked).toBe(0);
    expect(projectOnly.unlinkedShare).toBe(1);
  });

  it("a link in the project and the same link in the database are one place: linked, not multiple", async () => {
    const service = registryService(new SourceRegistry());
    const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
    await store.openFiles([DB]);
    const book = [...store.books.value.values()].find((b) => b.title === "תרגום אונקלוס על בראשית")!.key;
    const [first] = await service.existingLinks(book, 0, 5);
    expect(first).toBeDefined();
    const before = (await store.coverage.summary(book))!;
    // the same two lines as a project link, with the OTHER end's book spelled by another session key
    const otherSide = first!.source.book.key === book ? "target" : "source";
    const dup = { ...first!, id: "p1", status: "new" as const, provenance: "user" as const, [otherSide]: { ...first![otherSide], book: { ...first![otherSide].book, key: "other-session-key" } } };
    store.linkState.value = { ...store.linkState.value, links: new Map([[dup.id, dup]]) };
    const after = (await store.coverage.summary(book))!;
    expect(after.byBucket).toEqual(before.byBucket);
  });

  it("a pending suggestion makes its lines 'candidate' until approved (found, not approved), then 'linked'", async () => {
    const { store, key } = await opened();
    const book = key("ביאור על בראשית");
    const scope = { kind: "book", key: book } as const;
    await store.maxLink.run(store.maxLink.plan(scope, new Set(["headings"])), store.maxLink.scopeLabel(scope));
    const pending = (await store.coverage.summary(book))!;
    expect(pending.byBucket).toMatchObject({ candidate: 11, linked: 0, unlinked: 0 });
    expect((await store.coverage.summary(book, { includeCandidates: false }))!.byBucket).toMatchObject({ candidate: 0, unlinked: 11 });
    store.suggestions.approve(store.suggestions.pendingAtLeast("certain"));
    expect((await store.coverage.summary(book))!.byBucket).toMatchObject({ candidate: 1, linked: 10, unlinked: 0 });
  });

  it("a link the QA flags (an anchor outside its line) is 'doubtful' once the QA has run", async () => {
    const { store, key } = await opened();
    const book = key("ביאור על בראשית");
    const base = [...store.books.value.values()].find((b) => b.title === "בראשית")!;
    const mine = store.refOf(book);
    // line 3 is the first verse's text of the commentary; the anchor starts far beyond its end
    const bad = { id: "q1", status: "new" as const, provenance: "user" as const, source: { book: mine, line: 3 }, target: { book: store.refOf(base.key), line: 2 }, declaredType: "commentary", heRef2: "", anchor: { rawStart: 9999, rawEnd: 10005 } };
    store.linkState.value = { ...store.linkState.value, links: new Map([[bad.id, bad]]) };
    expect((await store.coverage.summary(book))!.byBucket).toMatchObject({ linked: 1, doubtful: 0 });
    await store.quality.run();
    expect(store.quality.report.value!.issues.some((i) => i.link.id === "q1")).toBe(true);
    expect((await store.coverage.summary(book))!.byBucket).toMatchObject({ linked: 0, doubtful: 1 });
    expect((await store.coverage.summary(book, { includeQa: false }))!.byBucket).toMatchObject({ linked: 1, doubtful: 0 });
  });

  it("a book that is not open has no coverage", async () => {
    const { store } = await opened();
    expect(await store.coverage.summary("ghost:1")).toBeNull();
  });
});

describe("a database that reports an absurd line count (QA round 2, B)", () => {
  function hostile(lineCount: number) {
    const book = { key: "k", title: "ספר ענק", origin: "otzaria", lineCount } as never;
    const reads = { headings: 0, lines: 0, existing: 0 };
    const host = {
      linkState: signal({ links: new Map() }),
      books: signal(new Map([["k", book]])),
      lines: { count: () => lineCount, learnCount: async () => lineCount },
      sameBook: () => true,
      runTask: async (_label: string, run: (o: object) => Promise<unknown>) => run({}),
      suggestions: { run: signal(null), state: signal(new Map()) },
      quality: { report: signal(null) },
    } as unknown as CoverageHost;
    const service = {
      headings: async () => (reads.headings++, []),
      lines: async () => (reads.lines++, []),
      existingLinks: async () => (reads.existing++, []),
    };
    return { state: new CoverageState(host, service as never), reads };
  }
  it("summary answers 'tooLarge' at once, reads nothing, and saves nothing to the project", async () => {
    const { state, reads } = hostile(1_000_000_000);
    const t0 = Date.now();
    const s = (await state.summary("k"))!;
    expect(s.tooLarge).toBe(true);
    expect(s.total).toBe(1_000_000_000);
    expect(reads).toEqual({ headings: 0, lines: 0, existing: 0 });
    expect(state.snapshot()).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it("the table gives that book a row that says tooLarge, with no reads", async () => {
    const { state, reads } = hostile(1_000_000_000);
    const [row] = await state.table(["k"], { headings: true });
    expect(row!.counts.tooLarge).toBe(true);
    expect(row!.exact).toBe(false);
    expect(reads).toEqual({ headings: 0, lines: 0, existing: 0 });
  });
});

describe("what coverage saves in the project, and the table's cost (QA round 2, F)", () => {
  const fresh = () => new AppStore(registryService(new SourceRegistry()), { save: () => {} }, loadPreferences(null));
  const commentaryKey = (s: AppStore) => [...s.books.value.values()].find((b) => b.title === "ביאור על בראשית")!.key;

  it("a partial count (no database links, no candidates, no QA, custom links or unsuitable lines) is returned but not saved as 'the coverage'", async () => {
    const store = fresh();
    await store.openFiles([DB, COMMENTARY]);
    const key = commentaryKey(store);
    for (const options of [{ includeDb: false }, { includeCandidates: false }, { includeQa: false }, { unsuitable: new Set<number>() }]) {
      expect(await store.coverage.summary(key, options), JSON.stringify(options)).not.toBeNull();
      expect(store.coverage.snapshot(), JSON.stringify(options)).toEqual([]);
    }
    expect(await store.coverage.summary(key, { extraLinks: [{ id: "x", status: "new", provenance: "user", source: { book: { key, title: "ביאור על בראשית", origin: "personal" }, line: 3 }, target: { book: { key: "z", title: "ז", origin: "otzaria" }, line: 1 }, declaredType: "commentary", heRef2: "" }] })).not.toBeNull();
    expect(store.coverage.snapshot()).toEqual([]);
    await store.coverage.summary(key);
    expect(store.coverage.snapshot()).toHaveLength(1);
    // and a later partial count does not overwrite the full one
    const before = JSON.stringify(store.coverage.snapshot());
    await store.coverage.summary(key, { includeDb: false });
    expect(JSON.stringify(store.coverage.snapshot())).toBe(before);
  });

  it("the table of 1,500 books with 60,000 project links reads the links by book once, not once per book", async () => {
    const BOOKS = 1_500;
    const ref = (i: number) => ({ key: `k${i}`, title: `ספר ${i}`, origin: "otzaria" as const });
    const books = new Map(Array.from({ length: BOOKS }, (_, i) => [`k${i}`, { key: `k${i}`, title: `ספר ${i}`, origin: "otzaria", lineCount: 10 }] as const));
    const links = Array.from({ length: 60_000 }, (_, i) => ({ id: `l${i}`, status: "new", provenance: "user", source: { book: ref(i % BOOKS), line: i % 10 }, target: { book: ref((i * 7 + 1) % BOOKS), line: 0 }, declaredType: "commentary", heRef2: "" }));
    let owned = 0;
    const host = {
      linkState: signal({ links: new Map(links.map((l) => [l.id, l])) }),
      books: signal(books),
      lines: { count: () => 10, learnCount: async () => 10 },
      sameBook: (r: { key: string }, k: string) => (owned++, r.key === k),
      runTask: async (_l: string, run: (o: object) => Promise<unknown>) => run({}),
      suggestions: { run: signal(null), state: signal(new Map()) },
      quality: { report: signal(null) },
    } as unknown as CoverageHost;
    const state = new CoverageState(host, { headings: async () => [], lines: async () => [], existingLinks: async () => [] } as never);
    const t0 = Date.now();
    const rows = await state.table([...books.keys()]);
    const ms = Date.now() - t0;
    expect(rows).toHaveLength(BOOKS);
    // book 0 is the source of the links with i % 1500 = 0 (always line 0) and the target of line 0 elsewhere: line 0 reaches several places and the other nine lines are unlinked
    expect(rows[0]!.counts.byBucket).toMatchObject({ multiple: 1, unlinked: 9 });
    expect(owned, "ownership checks").toBeLessThan(BOOKS * 2_000);
    expect(ms).toBeLessThan(2_500);
  }, 60_000);
});


