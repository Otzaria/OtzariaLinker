import { describe, expect, it } from "vitest";
import type { SourceBook, SourceLine } from "../../../src/core/books";
import { booksService } from "../../../src/app/books-service";
import { WorkerHost, type HostedWorker } from "../../../src/app/worker-host";
import { SourceRegistry } from "../../../src/sources/registry";
import type { InputFile, OpenedSource } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import { AppStore } from "../../../src/state/store";
import { serve, type FromWorker, type Handlers, type ToWorker } from "../../../src/workers/rpc";
import type { SourcesApi } from "../../../src/workers/sources-api";

/*
 * Review C2: after the worker is replaced, the new worker's sources must not take ids an earlier
 * worker gave, and the project's links must bind again by title — before, a new worker started again
 * at "s1", the links kept keys like "s1:7", and the database opened first after the restart took them:
 * the link showed (and an edit wrote) another book.
 *
 * The worker here is in-process (the protocol of rpc.ts over an asynchronous port). Its "databases"
 * stand for two real ones whose book ids collide: id 7 is "ספר א" in official.db and "ספר זר" in personal.db.
 * The ids follow the registry's rule (prefix from the host + a counter: SourceRegistry.useIdPrefix).
 */
const CATALOG: Record<string, [number, string][]> = {
  "official.db": [[7, "ספר א"], [8, "ספר ב"]],
  "personal.db": [[7, "ספר זר"], [8, "ספר אחר"]],
};

function fakeWorker(): HostedWorker {
  let prefix = "s";
  let seq = 0;
  const handlers = {
    init: (_c, p) => void (prefix = p),
    open: (_c, files: InputFile[]) => ({
      sources: files.map((f): OpenedSource => {
        const id = `${prefix}${++seq}`;
        return { info: { id, kind: "otzaria-db", label: f.path, warnings: [] }, books: CATALOG[f.path]!.map(([n, title]): SourceBook => ({ key: `${id}:${n}`, title, origin: "otzaria", lineCount: 20 })) };
      }),
      documents: [],
      skipped: [],
    }),
    lines: (_c, _key, from, to) => {
      const out: SourceLine[] = [];
      for (let i = from; i <= Math.min(to, 19); i++) out.push({ index: i, text: i ? `שורה ${i}` : "<h1>כותרת</h1>", anchorText: i ? `שורה ${i}` : "כותרת", heRef: null, heading: i ? null : 1, existsInDb: true });
      return out;
    },
    existingLinks: () => [],
    close: () => {},
  } as Partial<Handlers<SourcesApi>> as Handlers<SourcesApi>;
  const w: HostedWorker = {
    onmessage: null,
    onerror: null,
    terminate: () => void (dead = true),
    postMessage: (m: ToWorker) => queueMicrotask(() => !dead && handle(m)),
  };
  let dead = false;
  const handle = serve<SourcesApi>(handlers, (m: FromWorker) => queueMicrotask(() => !dead && w.onmessage?.({ data: m } as MessageEvent<FromWorker>)));
  return w;
}

const file = (path: string): InputFile => ({ path, blob: new Blob([]) });
const keyOf = (store: AppStore, title: string) => [...store.books.value.values()].find((b) => b.title === title)!.key;

describe("worker restart: book identity (review C2)", () => {
  it("a link keeps its books after a restart, whatever order the sources are opened again in", async () => {
    const host = new WorkerHost(fakeWorker);
    const store = new AppStore(booksService(host.call), { save: () => {} }, loadPreferences(null));
    host.onLost = (r) => store.workerLost(r);

    await store.openFiles([file("official.db"), file("personal.db")]);
    const a = keyOf(store, "ספר א");
    const b = keyOf(store, "ספר ב");
    expect(a).toBe("s1:7");
    await store.lines.load(a, 0, 19);
    await store.lines.load(b, 0, 19);
    store.pickLine("source", a, 3);
    store.pickLine("target", b, 5);
    const made = store.createFromDraft()!;
    expect(made.source.book.title).toBe("ספר א");

    host.restart("בדיקה");
    expect(store.sources.value).toEqual([]);
    // the link waits for its books by title, like a link of a saved project
    expect(store.linkState.value.links.get(made.id)!.source.book.key).toBe("unresolved:ספר א");

    // the other database first: before the fix it took "s1", and "s1:7" became "ספר זר"
    await store.openFiles([file("personal.db")]);
    await store.openFiles([file("official.db")]);
    expect(keyOf(store, "ספר זר")).toBe("s2.1:7");
    const link = store.linkState.value.links.get(made.id)!;
    expect(store.bookOf(link.source.book)?.title).toBe("ספר א");
    expect(link.source.book.key).toBe(keyOf(store, "ספר א"));
    expect(store.sameBook(link.source.book, keyOf(store, "ספר זר"))).toBe(false);

    // an edit (here: the type) keeps both books
    store.editInBuilder(made.id);
    await store.lines.load(keyOf(store, "ספר א"), 0, 19);
    await store.lines.load(keyOf(store, "ספר ב"), 0, 19);
    store.draftType.value = "commentary";
    const edited = store.createFromDraft()!;
    expect(edited.source.book.title).toBe("ספר א");
    expect(edited.target.book.title).toBe("ספר ב");
    expect(edited.source.line).toBe(3);
  });

  it("the restart forgets what pointed at the lost sources: the builder and the suggestions", async () => {
    const host = new WorkerHost(fakeWorker);
    const store = new AppStore(booksService(host.call), { save: () => {} }, loadPreferences(null));
    host.onLost = (r) => store.workerLost(r);
    await store.openFiles([file("official.db")]);
    const made = (store.pickLine("source", "s1:7", 3), store.pickLine("target", "s1:8", 5), await store.lines.load("s1:7", 0, 19), await store.lines.load("s1:8", 0, 19), store.createFromDraft()!);
    store.editInBuilder(made.id);
    store.suggestions.run.value = { engine: "headings", label: "x", result: { suggestions: [], notes: [], unmatched: [] }, at: 0, from: "s1:7" } as never;
    host.restart("בדיקה");
    expect(store.editing.value).toBeNull();
    expect(store.pick.source.value).toBeNull();
    expect(store.suggestions.run.value).toBeNull();
  });

  it("the real registry takes the host's prefix", async () => {
    const reg = new SourceRegistry();
    reg.useIdPrefix("s2.");
    const r = await reg.open([{ path: "a.txt", blob: new Blob(["<h1>א</h1>\nשורה"]) }]);
    expect(r.sources[0]!.info.id).toBe("s2.1");
    expect(() => reg.useIdPrefix("s:")).toThrow();
  });
});
