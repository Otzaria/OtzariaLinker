import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { booksService } from "../../../src/app/books-service";
import { WorkerHost, type HostedWorker } from "../../../src/app/worker-host";
import type { EngineId } from "../../../src/linking/automatic";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, KeyValueStore } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { serve, type FromWorker, type ToWorker } from "../../../src/workers/rpc";
import type { SourcesApi } from "../../../src/workers/sources-api";
import { sourcesHandlers } from "../../../src/workers/sources-handlers";
import { registryService } from "../../support/books-service";

/*
 * V7 §4.11: interruptions of a max-link job that maxlink-job.test.ts does not cover — the worker replaced in the middle (it crashed,
 * ran out of memory, or the watchdog replaced it), a source the worker lost while the job ran, a file deleted from the disk after it
 * was chosen, an engine that runs out of memory on one book, and the user's decisions between a pause and the resume. In every case:
 * the finished books are kept, no decision is overwritten, and the resume runs each book once and shows each suggestion once.
 */
const HEB = ["א", "ב", "ג", "ד", "ה"];
const BASE = ["<h1>בראשית</h1>", ...HEB.flatMap((p, c) => [`<h2>פרק ${p}</h2>`, ...HEB.map((_, v) => `(${HEB[v]}) פסוק ${v + 1} של פרק ${c + 1} בספר.`)])];
const commentary = (n: number) => [`<h1>ביאור ${n} על בראשית</h1>`, `<h2>פרק ${HEB[n - 1]}</h2>`, ...HEB.flatMap((p, v) => [`<h3>פסוק ${p}</h3>`, `ביאור ${n} לפסוק ${v + 1}`])];
const TITLES = [1, 2, 3, 4, 5].map((n) => `ביאור ${n} על בראשית`);
const HEADINGS: ReadonlySet<EngineId> = new Set(["headings"]);

/** files of the folder; a path in `gone` reads as a file deleted from the disk after it was chosen (Chrome: NotReadableError) */
function folder(gone: ReadonlySet<string> = new Set()) {
  class FileBlob extends Blob {
    constructor(
      private readonly path: string,
      lines: readonly string[],
    ) {
      super([strToU8(lines.join("\n"))]);
    }
    override arrayBuffer(): Promise<ArrayBuffer> {
      return gone.has(this.path) ? Promise.reject(new DOMException("The requested file could not be read", "NotReadableError")) : super.arrayBuffer();
    }
  }
  const file = (path: string, lines: readonly string[]) => ({ path, blob: new FileBlob(path, lines) as Blob });
  return [file("ביאורים/בראשית.txt", BASE), ...[1, 2, 3, 4, 5].map((n) => file(`ביאורים/ביאור ${n} על בראשית.txt`, commentary(n)))];
}

const memKv = () => {
  const mem = new Map<string, string>();
  const kv: KeyValueStore = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k) };
  return { mem, kv };
};

/** A store over `service`, whose max-link calls are counted by book and can be hooked (before the call, or to wrap its promise). */
function withCalls(service: BooksService, hook: (title: string, n: number, call: () => ReturnType<NonNullable<BooksService["runMaxLink"]>>) => ReturnType<NonNullable<BooksService["runMaxLink"]>> = (_t, _n, call) => call()) {
  const calls: string[] = [];
  const run = service.runMaxLink!.bind(service);
  const wrapped: BooksService = {
    ...service,
    runMaxLink: (steps, options, opts) => {
      const title = steps[0]!.source.title;
      calls.push(title);
      return hook(title, calls.length, () => run(steps, options, opts));
    },
  };
  return { store: new AppStore(wrapped, { save: () => {} }, loadPreferences(null)), calls };
}

async function openFolder(store: AppStore, gone?: ReadonlySet<string>) {
  await store.openFiles(folder(gone));
  return { kind: "source", id: store.sources.value.at(-1)!.info.id } as const;
}

/** every suggestion of the run once, on open books only; every book of the job ran to "done" */
function expectWhole(store: AppStore, n = 25) {
  const sugs = store.suggestions.run.value!.result.suggestions;
  expect(sugs).toHaveLength(n);
  expect(new Set(sugs.map((s) => s.id)).size).toBe(n);
  const open = new Set(store.books.value.keys());
  expect(sugs.every((s) => open.has(s.source.book.key) && open.has(s.target.book.key))).toBe(true);
  expect(store.maxLink.job.value!.books.filter((b) => b.status === "done").map((b) => b.title).sort()).toEqual(TITLES);
}

/** an in-process worker over a real registry, through the worker's protocol (rpc.ts serve) on an asynchronous port */
function realWorker(): HostedWorker {
  let dead = false;
  const w: HostedWorker = {
    onmessage: null,
    onerror: null,
    terminate: () => void (dead = true),
    postMessage: (m: ToWorker) => queueMicrotask(() => !dead && handle(m)),
  };
  const handle = serve<SourcesApi>(sourcesHandlers(new SourceRegistry()), (m: FromWorker) => queueMicrotask(() => !dead && w.onmessage?.({ data: m } as MessageEvent<FromWorker>)));
  return w;
}

/*
 * Found by the staged load run on seforim.db (V7 §4.9, stage 50): after a reload the job resumed with 22,034 suggestions instead of
 * 23,230, and 35 approved suggestions were no longer in it. The plan of the run had read the database's links of the chosen books
 * (gatherEvidence: "שער הציון" is on "משנה ברורה" only by its links); the resumed job planned again without them, so its finished
 * books' steps differed from those they ran with — "changed" — and they ran again with a poorer plan. The job keeps the evidence its
 * plan used, by title, and plans the same after a reload.
 */
describe("a job planned with the database's own links resumes with the same plan", () => {
  const DB = () => ({ path: "seforim.db", blob: new Blob([readFileSync("tests/fixtures/db/seforim-v7-mini.db")]) });

  // every engine, as the app ticks them: without the evidence the book still has a step (citations), so a poorer plan is not "no plan"
  it("after a reload nothing finished runs again, and the suggestions and decisions are those of the run", async () => {
    const { kv } = memKv();
    const a = withCalls(registryService(new SourceRegistry()));
    a.store.maxLink.startPersist(kv);
    await a.store.openFiles([DB()]);
    const key = (s: AppStore, t: string) => [...s.books.value.values()].find((b) => b.title === t)!.key;
    const scope = { kind: "book", key: key(a.store, "שער הציון") } as const;
    await a.store.maxLink.gatherEvidence(scope);
    const plan = a.store.maxLink.plan(scope);
    expect(plan.steps.map((s) => (s.kind === "pair" ? `${s.engine}:${s.target.title}` : s.engine)).sort()).toEqual(["citations", "dibur-hamatchil:משנה ברורה", "headings:משנה ברורה"]);
    await a.store.maxLink.run(plan, "שער הציון");
    const status = a.store.maxLink.job.value!.books.find((x) => x.title === "שער הציון")!.status;
    expect(["done", "no-match"]).toContain(status);
    const was = a.store.suggestions.run.value?.result.suggestions.map((s) => s.id) ?? [];
    a.store.suggestions.approve(was.slice(0, 1));
    await new Promise((res) => setTimeout(res, 1100)); // the job record is written a second after a book
    const project = a.store.projectText();

    const b = withCalls(registryService(new SourceRegistry()));
    b.store.maxLink.startPersist(kv);
    await new Promise((res) => setTimeout(res, 0));
    await b.store.openFiles([DB()]);
    b.store.openProject("p.otzlinker.json", project);
    await b.store.maxLink.resume();
    expect(b.calls).toEqual([]);
    expect(b.store.maxLink.job.value!.books.find((x) => x.title === "שער הציון")!.status).toBe(status);
    expect(b.store.suggestions.run.value?.result.suggestions.map((s) => s.id) ?? []).toEqual(was);
    if (was.length) expect(b.store.suggestions.state.value.get(was[0]!)).toBe("approved");
    // and "run again what changed" finds nothing changed
    await b.store.maxLink.rerunChanged();
    expect(b.calls).toEqual([]);
  });
});

describe("max-link job: interruptions (V7 §4.11)", () => {
  it("the worker is replaced in the middle (a crash, out of memory, the watchdog): the finished books are kept, nothing points at the lost sources, and the resume completes the job", async () => {
    const host = new WorkerHost(realWorker);
    const { store, calls } = withCalls(booksService(host.call), (_t, n, call) => {
      const p = call();
      // the third book's call is in the worker when the worker goes
      if (n === 3) host.restart("מנוע הקריאה קרס (ייתכן שקובץ פגום).");
      return p;
    });
    host.onLost = (r) => store.workerLost(r);
    const scope = await openFolder(store);
    await store.maxLink.run(store.maxLink.plan(scope, HEADINGS), "ביאורים");
    let job = store.maxLink.job.value!;
    expect(job.state).toBe("paused");
    expect(job.books.filter((b) => b.status === "done").map((b) => b.title)).toEqual(TITLES.slice(0, 2));
    expect(job.books.find((b) => b.title === TITLES[2])).toMatchObject({ status: "failed" });
    expect(store.sources.value).toEqual([]);
    // the lost sources' lines: no suggestion of them is offered for approval (an approval would make a link to a book that is gone)
    const open = new Set(store.books.value.keys());
    const offered = store.suggestions.run.value?.result.suggestions ?? [];
    expect(offered.filter((s) => !open.has(s.source.book.key) || !open.has(s.target.book.key))).toEqual([]);
    expect(store.notices.value.at(-1)!.text).toContain("אחרי שתפתחו שוב את הספרים");

    // the folder opened again (new keys, a new worker): resume runs the books that wait, "retry failed" the crashed one
    await openFolder(store);
    expect(await store.maxLink.resume()).toBe(true);
    expect(calls.slice(3)).toEqual([TITLES[3], TITLES[4]]);
    await store.maxLink.retryFailed();
    expect(calls.slice(5)).toEqual([TITLES[2]]);
    job = store.maxLink.job.value!;
    expect(job.state).toBe("done");
    expectWhole(store);
  });

  it("a source the worker lost while the job ran: its books fail with a reason, the finished ones stay, and the folder opened again completes the job", async () => {
    const registry = new SourceRegistry();
    const { store, calls } = withCalls(registryService(registry), (_t, n, call) => {
      // the worker no longer holds the folder (as after a close the UI did not make): from the fourth book on
      if (n === 4) registry.close(store.sources.value[0]!.info.id);
      return call();
    });
    const scope = await openFolder(store);
    // the UI's own close is refused while the job runs
    const refused = store.maxLink.run(store.maxLink.plan(scope, HEADINGS), "ביאורים");
    expect(await store.closeSource(scope.id)).toBe(false);
    await refused;
    let job = store.maxLink.job.value!;
    expect(job.state).toBe("done");
    expect(job.books.filter((b) => b.status === "done").map((b) => b.title)).toEqual(TITLES.slice(0, 3));
    expect(job.books.filter((b) => b.status === "failed").map((b) => b.title)).toEqual(TITLES.slice(3));
    expect(store.suggestions.run.value!.result.suggestions).toHaveLength(15);

    await store.closeSource(scope.id);
    await openFolder(store);
    calls.length = 0;
    await store.maxLink.retryFailed();
    expect(calls).toEqual(TITLES.slice(3));
    expectWhole(store);
  });

  it("a file deleted from the disk after it was chosen: that book fails with what to do, the others finish", async () => {
    const gone = new Set<string>();
    const { store, calls } = withCalls(registryService(new SourceRegistry()), (_t, n, call) => {
      if (n === 2) gone.add("ביאורים/ביאור 4 על בראשית.txt");
      return call();
    });
    const scope = await openFolder(store, gone);
    await store.maxLink.run(store.maxLink.plan(scope, HEADINGS), "ביאורים");
    const job = store.maxLink.job.value!;
    expect(job.state).toBe("done");
    const failed = job.books.find((b) => b.status === "failed")!;
    expect(failed.title).toBe(TITLES[3]);
    expect(failed.why).toContain("בחרו את התיקייה או הקבצים שוב");
    expect(job.books.filter((b) => b.status === "done")).toHaveLength(4);
    expect(store.suggestions.run.value!.result.suggestions).toHaveLength(20);
    // the file is back (chosen again): only it runs
    gone.clear();
    calls.length = 0;
    await store.maxLink.retryFailed();
    expect(calls).toEqual([TITLES[3]]);
    expectWhole(store);
  });

  it("an engine that runs out of memory on one book: that book fails with the error, the next ones run, and a retry completes it", async () => {
    let oom = true;
    const { store, calls } = withCalls(registryService(new SourceRegistry()), (title, _n, call) => (title === TITLES[1] && oom ? Promise.reject(new RangeError("Array buffer allocation failed")) : call()));
    const scope = await openFolder(store);
    await store.maxLink.run(store.maxLink.plan(scope, HEADINGS), "ביאורים");
    const job = store.maxLink.job.value!;
    expect(job.state).toBe("done");
    expect(job.books.find((b) => b.title === TITLES[1])).toMatchObject({ status: "failed", why: "Array buffer allocation failed" });
    expect(calls).toEqual(TITLES);
    oom = false;
    calls.length = 0;
    await store.maxLink.retryFailed();
    expect(calls).toEqual([TITLES[1]]);
    expectWhole(store);
  });

  it("decisions made while the job is paused stay as they are through the resume, and through a reload and a resume", async () => {
    const { kv } = memKv();
    const a = withCalls(registryService(new SourceRegistry()), (_t, n, call) => (n === 3 && a.store.maxLink.pause(), call()));
    a.store.maxLink.startPersist(kv);
    const scope = await openFolder(a.store);
    await a.store.maxLink.run(a.store.maxLink.plan(scope, HEADINGS), "ביאורים");
    expect(a.store.maxLink.job.value!.state).toBe("paused");
    const on = (store: AppStore, n: number) => store.suggestions.run.value!.result.suggestions.filter((s) => s.source.book.title === TITLES[n - 1]).map((s) => s.id);
    // decisions on the finished books: approve two of book 1 and change one's type, reject one of book 2
    const [x, y] = on(a.store, 1);
    const [r] = on(a.store, 2);
    a.store.suggestions.approve([x!, y!]);
    a.store.setType([`auto:${x}`], "reference");
    a.store.suggestions.reject([r!]);
    const links = a.store.allLinks.value.length;
    expect(await a.store.maxLink.resume()).toBe(true);
    expect(a.calls).toEqual([TITLES[0], TITLES[1], TITLES[2], TITLES[2], TITLES[3], TITLES[4]]);
    expectWhole(a.store);
    const kept = (store: AppStore) => {
      const st = store.suggestions.state.value;
      expect(st.get(x!)).toBe("approved");
      expect(st.get(y!)).toBe("approved");
      expect(st.get(r!)).toBe("rejected");
      expect(store.allLinks.value).toHaveLength(links);
      expect(store.allLinks.value.find((l) => l.id === `auto:${x}`)!.declaredType).toBe("reference");
      expect(store.suggestions.counts.value).toMatchObject({ approved: 2, rejected: 1 });
    };
    kept(a.store);

    // a reload in the middle of a second run: the project (decisions) and the job come back from the browser
    const second = withCalls(registryService(new SourceRegistry()), (_t, n, call) => (n === 2 && second.store.maxLink.pause(), call()));
    second.store.maxLink.startPersist(kv);
    await new Promise((res) => setTimeout(res, 0));
    second.store.maxLink.discardJob();
    const s2 = await openFolder(second.store);
    second.store.openProject("p.otzlinker.json", a.store.projectText());
    await second.store.maxLink.run(second.store.maxLink.plan(s2, HEADINGS), "ביאורים");
    expect(second.store.maxLink.job.value!.state).toBe("paused");
    await new Promise((res) => setTimeout(res, 1100)); // the job record is written a second after a book (maxlink.ts saveSoon)
    const project = second.store.projectText();

    const c = withCalls(registryService(new SourceRegistry()));
    c.store.maxLink.startPersist(kv);
    await new Promise((res) => setTimeout(res, 0));
    expect(c.store.maxLink.jobRestored.value).toBe(true);
    await openFolder(c.store);
    c.store.openProject("p.otzlinker.json", project);
    expect(await c.store.maxLink.resume()).toBe(true);
    // the finished book is not run again; the rest run once each
    expect(c.calls).toEqual(TITLES.slice(1));
    expectWhole(c.store);
    kept(c.store);
  });
});
