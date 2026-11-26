import { appendFileSync } from "node:fs";
import { effect } from "@preact/signals";
import { describe, expect, it } from "vitest";
import { booksService } from "../../../src/app/books-service";
import { WorkerHost, type HostedWorker } from "../../../src/app/worker-host";
import { SourceRegistry } from "../../../src/sources/registry";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, KeyValueStore } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { serve, type FromWorker, type ToWorker } from "../../../src/workers/rpc";
import type { SourcesApi } from "../../../src/workers/sources-api";
import { sourcesHandlers } from "../../../src/workers/sources-handlers";
import { fileBlob, fingerprint } from "../../validation/env";

/*
 * V7 §4.11 on the real library: ONE max-link job over a seeded set of books of seforim.db, interrupted every way the app meets —
 * pause, stop, the worker replaced, the source lost by the worker, the file unreadable, one book that fails, a memory limit, and a
 * reload (the job and the project restored from the browser's storage into a new store) — with the user's decisions made in the
 * middle. At the end it is compared with the same job run without interruption: the same suggestions, each once; every decision
 * as it was made; no finished book run again. The small-fixture versions are maxlink-interruptions.test.ts and maxlink-job.test.ts.
 *
 *   OTZARIA_DB=… OTZARIA_INTERRUPT=1 [OTZARIA_INTERRUPT_BOOKS=30] [OTZARIA_INTERRUPT_HEAP_MB=…] [MEASURE_OUT=file]
 *   npx vitest run tests/integration/state/v7-interruptions.local.test.ts
 * The store runs over WorkerHost with the worker's own handlers on a real registry, in process (rpc.ts serve over an asynchronous
 * port), so a worker replacement is the app's own (WorkerHost.restart → AppStore.workerLost).
 */
const DB = process.env.OTZARIA_DB;
const ON = !!process.env.OTZARIA_INTERRUPT;
const BOOKS = Number(process.env.OTZARIA_INTERRUPT_BOOKS ?? 30);
const SEED = 49;
const log = (line: string) => {
  console.log(line);
  if (process.env.MEASURE_OUT) appendFileSync(process.env.MEASURE_OUT, `${line}\n`);
};
const MB = 2 ** 20;
const gc = () => (globalThis as { gc?: () => void }).gc?.();

function rng(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** the database as a file the user chose: readable until `gone` says it was deleted from the disk */
async function dbFile(state: { gone: boolean }) {
  const blob = await fileBlob(DB!);
  const wrap = (b: Blob): Blob =>
    ({
      size: b.size,
      type: "",
      slice: (s?: number, e?: number) => wrap(b.slice(s, e)),
      arrayBuffer: () => (state.gone ? Promise.reject(new DOMException("The requested file could not be read", "NotReadableError")) : b.arrayBuffer()),
    }) as unknown as Blob;
  return { path: "seforim.db", blob: wrap(blob) };
}

/** a host over an in-process worker on a real registry; `registry` is the current worker's */
function host() {
  const cur: { registry: SourceRegistry } = { registry: new SourceRegistry() };
  const spawn = (): HostedWorker => {
    const registry = (cur.registry = new SourceRegistry());
    let dead = false;
    const w: HostedWorker = { onmessage: null, onerror: null, terminate: () => void (dead = true), postMessage: (m: ToWorker) => queueMicrotask(() => !dead && handle(m)) };
    const handle = serve<SourcesApi>(sourcesHandlers(registry), (m: FromWorker) => queueMicrotask(() => !dead && w.onmessage?.({ data: m } as MessageEvent<FromWorker>)));
    return w;
  };
  return { worker: new WorkerHost(spawn), cur };
}

type Hook = (title: string, n: number) => void | Promise<void>;
function makeStore(kv?: KeyValueStore) {
  const h = host();
  const base = booksService(h.worker.call);
  const calls: string[] = [];
  const hooks: Hook[] = [];
  const run = base.runMaxLink!.bind(base);
  const service: BooksService = {
    ...base,
    runMaxLink: async (steps, options, opts) => {
      const title = steps[0]!.source.title;
      calls.push(title);
      for (const f of hooks) await f(title, calls.length);
      return run(steps, options, opts);
    },
  };
  const store = new AppStore(service, { save: () => {} }, loadPreferences(null));
  h.worker.onLost = (r) => store.workerLost(r);
  if (kv) store.maxLink.startPersist(kv);
  return { store, calls, hooks, host: h };
}

describe.runIf(DB && ON)("V7 §4.11: interruptions of a large max-link job on the real library (read-only)", () => {
  it(`${BOOKS} books, interrupted every way, against the same job run straight`, { timeout: 6 * 3600_000 }, async () => {
    const before = fingerprint(DB!);
    const file = { gone: false };
    const mem = new Map<string, string>();
    const kv: KeyValueStore = { get: async (k) => mem.get(k) ?? null, set: async (k, v) => void mem.set(k, v), delete: async (k) => void mem.delete(k) };

    /* the books: the seeded shuffle of every book the full plan pairs (as v7-load-staged.local.test.ts) */
    const straight = makeStore();
    await straight.store.openFiles([await dbFile(file)]);
    const src = straight.store.sources.value[0]!;
    const full = straight.store.maxLink.plan({ kind: "source", id: src.info.id });
    const titles = [...new Set(full.steps.filter((s) => s.kind === "pair").map((s) => s.source.key))].map((k) => straight.store.refOf(k).title).sort();
    const r = rng(SEED);
    for (let i = titles.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [titles[i], titles[j]] = [titles[j]!, titles[i]!];
    }
    const chosen = titles.slice(0, BOOKS);
    const scopeOf = (store: AppStore) => {
      const byTitle = new Map(store.sources.value.flatMap((s) => s.books).map((b) => [b.title, b.key] as const));
      return { kind: "books", keys: chosen.flatMap((t) => byTitle.get(t) ?? []) } as const;
    };

    /* the job run straight, for comparison */
    let t0 = performance.now();
    await straight.store.maxLink.run(straight.store.maxLink.plan(scopeOf(straight.store)), "straight");
    const want = new Set(straight.store.suggestions.run.value!.result.suggestions.map((s) => s.id));
    const order = straight.calls.slice();
    log(`[straight] ${chosen.length} books, ${Math.round(performance.now() - t0)} ms, ${want.size} suggestions, ${JSON.stringify(Object.entries(straight.store.maxLink.job.value!.books.reduce<Record<string, number>>((m, b) => ((m[b.status] = (m[b.status] ?? 0) + 1), m), {})))}`);
    await straight.store.closeSource(src.info.id);

    /* the interrupted job */
    const a = makeStore(kv);
    await a.store.openFiles([await dbFile(file)]);
    const rows: Record<string, unknown>[] = [];
    const ranAfterDone: string[] = [];
    const done = new Set<string>();
    a.hooks.push((t) => void (done.has(t) && ranAfterDone.push(t)));
    const track = () => {
      for (const b of a.store.maxLink.job.value?.books ?? []) if (b.status === "done" || b.status === "no-match") done.add(b.title);
    };
    const stopAt = (n: number, how: () => void) => {
      let fired = false;
      a.hooks.push((_t, k) => {
        if (fired || k !== n) return;
        fired = true;
        // in the middle of the book: after its call reached the worker
        setTimeout(how, 300);
      });
    };
    const measure = async (name: string, go: () => Promise<unknown>) => {
      const t = performance.now();
      await go();
      track();
      const job = a.store.maxLink.job.value!;
      const st: Record<string, number> = {};
      for (const b of job.books) st[b.status] = (st[b.status] ?? 0) + 1;
      rows.push({ name, ms: Math.round(performance.now() - t), state: job.state, books: st, heapMB: Math.round(process.memoryUsage().heapUsed / MB) });
      log(`  ${name}: ${Math.round(performance.now() - t)} ms → ${job.state} ${JSON.stringify(st)}`);
    };
    let pausedAt = 0;
    const pause = () => ((pausedAt = performance.now()), a.store.maxLink.pause());
    const latency = () => Math.round(performance.now() - pausedAt);

    // 1. pause in the middle of the 5th book
    stopAt(5, pause);
    await measure("run → pause at book 5", () => a.store.maxLink.run(a.store.maxLink.plan(scopeOf(a.store)), "interrupted"));
    log(`    stopped ${latency()} ms after the pause`);
    expect(a.store.maxLink.job.value!.state).toBe("paused");

    // decisions on the finished books
    const sugs = () => a.store.suggestions.run.value!.result.suggestions;
    const pending = sugs().filter((s) => a.store.suggestions.state.value.get(s.id) === "pending");
    const approved = pending.filter((s) => s.confidence === "certain").slice(0, 3).map((s) => s.id);
    const rejected = pending.filter((s) => s.confidence !== "certain").slice(0, 2).map((s) => s.id);
    a.store.suggestions.approve(approved);
    a.store.suggestions.reject(rejected);
    const retyped = a.store.allLinks.value.find((l) => l.id.startsWith("auto:"))?.id;
    if (retyped) a.store.setType([retyped], "reference");
    log(`    decisions: approved ${approved.length}, rejected ${rejected.length}, retyped ${retyped ? 1 : 0}; links ${a.store.allLinks.value.length}`);
    const links = a.store.allLinks.value.length;

    // 2. stop (the app bar's cancel) in the middle of the 9th call
    stopAt(9, () => ((pausedAt = performance.now()), a.store.task.value!.cancel()));
    await measure("resume → stop at call 9", () => a.store.maxLink.resume());
    log(`    stopped ${latency()} ms after the stop`);

    // 3. the worker replaced in the middle of call 13 (a crash, out of memory, the watchdog)
    stopAt(13, () => a.host.worker.restart("מנוע הקריאה קרס (בדיקה)."));
    await measure("resume → worker replaced at call 13", () => a.store.maxLink.resume());
    expect(a.store.sources.value).toEqual([]);
    expect(a.store.suggestions.run.value).toBeNull();
    await a.store.openFiles([await dbFile(file)]);

    // 4. the worker loses the database at call 17 (as a close the UI did not make): the books after it fail; and one book always fails
    const failing = chosen[20]!;
    let failOnce = true;
    a.hooks.push((t) => {
      if (t === failing && failOnce) throw ((failOnce = false), new Error("כשל מכוון בספר אחד (בדיקה)."));
    });
    let lostAt = 0;
    a.hooks.push((_t, k) => {
      if (k === 17 && !lostAt) (lostAt = k), a.host.cur.registry.close(a.store.sources.value[0]!.info.id);
    });
    await measure("resume → source lost at call 17", () => a.store.maxLink.resume());
    await a.store.closeSource(a.store.sources.value[0]!.info.id);
    await a.store.openFiles([await dbFile(file)]);

    // 5. the file deleted from the disk while the failed books run again (a few calls later), then chosen again
    let goneAt = 0;
    const firstRetry = a.calls.length + 3;
    a.hooks.push((_t, k) => void (k === firstRetry && !goneAt && ((goneAt = k), (file.gone = true))));
    await measure("retry failed → file unreadable 3 calls in", () => a.store.maxLink.retryFailed());
    file.gone = false;
    await a.store.closeSource(a.store.sources.value[0]!.info.id);
    await a.store.openFiles([await dbFile(file)]);

    // 6. a memory limit: the host pauses the job when the heap passes it (the app has none of its own); collect, then go on
    gc();
    const limit = Number(process.env.OTZARIA_INTERRUPT_HEAP_MB ?? Math.round(process.memoryUsage().heapUsed / MB) + 150) * MB;
    let overAt = 0;
    const guard = effect(() => {
      void a.store.task.value?.done;
      if (!overAt && a.store.maxLink.running.peek() && process.memoryUsage().heapUsed > limit) (overAt = Math.round(process.memoryUsage().heapUsed / MB)), pause();
    });
    await measure(`retry failed → memory limit ${Math.round(limit / MB)} MB`, () => a.store.maxLink.retryFailed());
    guard();
    gc();
    log(`    paused at heap ${overAt} MB${overAt ? `, ${latency()} ms after`: " (not reached)"}; after GC ${Math.round(process.memoryUsage().heapUsed / MB)} MB`);

    // 7. a reload in the middle: the job record is written a second after a book; the project is the autosave's text
    stopAt(a.calls.length + 2, pause);
    await measure("resume → pause before a reload", () => (a.store.maxLink.job.value!.books.some((b) => b.status === "failed") ? a.store.maxLink.retryFailed() : a.store.maxLink.resume()));
    await new Promise((res) => setTimeout(res, 1200));
    const project = a.store.projectText();
    const stored = [...mem.values()].reduce((s, v) => s + v.length, 0);
    log(`    stored in the browser: ${mem.size} entries, ${(stored / 1e6).toFixed(1)}M chars; project ${(project.length / 1e3).toFixed(0)}K chars`);
    const doneBeforeReload = new Set(done);

    const b = makeStore(kv);
    await new Promise((res) => setTimeout(res, 0));
    expect(b.store.maxLink.jobRestored.value).toBe(true);
    await b.store.openFiles([await dbFile(file)]);
    b.store.openProject("autosave.otzlinker.json", project);
    b.hooks.push((t) => void (doneBeforeReload.has(t) && ranAfterDone.push(`${t} (after the reload)`)));
    t0 = performance.now();
    await b.store.maxLink.resume();
    if (b.store.maxLink.job.value!.books.some((x) => x.status === "failed")) await b.store.maxLink.retryFailed();
    rows.push({ name: "reload → resume", ms: Math.round(performance.now() - t0), state: b.store.maxLink.job.value!.state });
    log(`  reload → resume (+ retry failed): ${Math.round(performance.now() - t0)} ms → ${b.store.maxLink.job.value!.state}`);

    /* the end: the same suggestions as the straight run, each once; every decision kept; nothing finished ran again */
    const got = b.store.suggestions.run.value!.result.suggestions.map((s) => s.id);
    const job = b.store.maxLink.job.value!;
    const calls = [...a.calls, ...b.calls];
    const perBook = new Map<string, number>();
    for (const t of calls) perBook.set(t, (perBook.get(t) ?? 0) + 1);
    log(`[interrupted] ${calls.length} calls for ${chosen.length} books (straight: ${order.length}); books run more than once: ${[...perBook].filter(([, n]) => n > 1).length}; ran after they were done: ${ranAfterDone.length}`);
    log(`  suggestions ${got.length} (unique ${new Set(got).size}), straight ${want.size}; missing ${[...want].filter((x) => !got.includes(x)).length}, extra ${got.filter((x) => !want.has(x)).length}`);
    log(`  rows ${JSON.stringify(rows)}`);
    expect(job.state).toBe("done");
    expect(job.books.filter((x) => x.status === "failed")).toEqual([]);
    expect(new Set(got).size).toBe(got.length);
    expect(new Set(got)).toEqual(want);
    expect(ranAfterDone).toEqual([]);
    const st = b.store.suggestions.state.value;
    for (const id of approved) expect(st.get(id)).toBe("approved");
    for (const id of rejected) expect(st.get(id)).toBe("rejected");
    if (retyped) expect(b.store.allLinks.value.find((l) => l.id === retyped)!.declaredType).toBe("reference");
    expect(b.store.allLinks.value).toHaveLength(links);
    expect(fingerprint(DB!)).toBe(before);
  });
});
