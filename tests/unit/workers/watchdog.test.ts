import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STUCK_MS, WorkerHost, type HostedWorker } from "../../../src/app/worker-host";
import { serve, type FromWorker, type Handlers, type ToWorker } from "../../../src/workers/rpc";
import type { SourcesApi } from "../../../src/workers/sources-api";

/*
 * Review C3: the watchdog replaced the worker on EVERY cancel — also of a request still queued behind
 * a job nobody cancelled (a search typed while an engine runs), killing the engine and every open
 * source. Now it acts only when a call the worker had started was cancelled, the worker does not
 * answer a probe for STUCK_MS, and nothing else the user waits for is running.
 *
 * The worker is simulated as what it is: one thread that reads one message at a time, and that reads
 * nothing while a synchronous job holds it (`hold`). Time is fake.
 */
class SimWorker implements HostedWorker {
  onmessage: HostedWorker["onmessage"] = null;
  onerror: HostedWorker["onerror"] = null;
  dead = false;
  readonly seen: ToWorker[] = [];
  private readonly inbox: ToWorker[] = [];
  private busy = false;
  private pumping = false;
  private readonly handle: (m: ToWorker) => void;

  constructor(handlers: (w: SimWorker) => Partial<Handlers<SourcesApi>>) {
    this.handle = serve<SourcesApi>({ init: () => {}, ...handlers(this) } as Handlers<SourcesApi>, (m: FromWorker) =>
      setTimeout(() => !this.dead && this.onmessage?.({ data: m } as MessageEvent<FromWorker>), 0),
    );
  }
  postMessage(m: ToWorker): void {
    this.seen.push(m);
    this.inbox.push(m);
    this.pump();
  }
  terminate(): void {
    this.dead = true;
  }
  /** a synchronous job of `ms`: the worker reads no message until it ends; resolves when it ends */
  hold(ms: number): Promise<void> {
    this.busy = true;
    return new Promise((r) => setTimeout(() => ((this.busy = false), r(), this.pump()), ms));
  }
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    setTimeout(() => {
      this.pumping = false;
      if (this.busy || this.dead) return;
      const m = this.inbox.shift();
      if (!m) return;
      this.handle(m);
      if (this.inbox.length) this.pump();
    }, 0);
  }
}

/** an engine that runs synchronously for `ms` and ignores the cancel (the old engines in the worker) */
const syncEngine = (w: SimWorker, ms: number) => async () => (await w.hold(ms), { suggestions: [], notes: [], unmatched: [] });

function setup(handlers: (w: SimWorker) => Partial<Handlers<SourcesApi>>) {
  const workers: SimWorker[] = [];
  const lost: string[] = [];
  const host = new WorkerHost(() => {
    const w = new SimWorker(handlers);
    workers.push(w);
    return w;
  });
  host.onLost = (r) => lost.push(r);
  return { host, workers, lost };
}

const settle = <T,>(p: Promise<T>) => p.then((value) => ({ value }), (error: { code?: string }) => ({ error: error.code }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the worker's watchdog (review C3)", () => {
  it("cancelling a search queued behind a running engine leaves the engine and the worker alone", async () => {
    const { host, workers, lost } = setup((w) => ({
      runEngine: syncEngine(w, 6000),
      searchBook: (_c, _k, query) => ({ query, hits: [], scanned: 0, truncated: false }),
    }));
    const engine = settle(host.call("runEngine", ["headings", { key: "s1:1", title: "א", origin: "otzaria" }, { key: "s1:2", title: "ב", origin: "otzaria" }, {}]));
    await vi.advanceTimersByTimeAsync(100);
    // the user types in Ctrl+F: each new search cancels the one before (state/book-find.ts)
    const ac = new AbortController();
    const search = settle(host.call("searchBook", ["s1:1", "של", {}], { signal: ac.signal }));
    await vi.advanceTimersByTimeAsync(50);
    ac.abort();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await search).toEqual({ error: "cancelled" });
    expect(await engine).toEqual({ value: { suggestions: [], notes: [], unmatched: [] } });
    expect(lost).toEqual([]);
    expect(workers).toHaveLength(1);
  });

  it("a cancelled call the worker started and that keeps it busy is replaced after STUCK_MS", async () => {
    const { host, workers, lost } = setup((w) => ({ runEngine: syncEngine(w, 60_000), lines: () => [] }));
    const ac = new AbortController();
    const engine = settle(host.call("runEngine", ["headings", { key: "s1:1", title: "א", origin: "otzaria" }, { key: "s1:2", title: "ב", origin: "otzaria" }, {}], { signal: ac.signal }));
    await vi.advanceTimersByTimeAsync(100);
    const queued = settle(host.call("lines", ["s1:1", 0, 10]));
    ac.abort();
    expect(await engine).toEqual({ error: "cancelled" }); // the UI never waits for the worker
    await vi.advanceTimersByTimeAsync(STUCK_MS - 200);
    expect(lost).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    expect(lost).toEqual(["הפעולה שבוטלה לא נעצרה, ולכן מנוע הקריאה הופעל מחדש."]);
    expect(workers).toHaveLength(2);
    expect(workers[0]!.dead).toBe(true);
    expect(await queued).toEqual({ error: "worker/restarted" });
  });

  it("a cancelled call that stops at its next slice does not restart the worker", async () => {
    const { host, lost } = setup(() => ({
      async runEngine(ctx) {
        for (;;) {
          await new Promise((r) => setTimeout(r, 30)); // a slice of work, then the worker reads its messages
          ctx.signal.throwIfAborted();
        }
      },
    }));
    const ac = new AbortController();
    const engine = settle(host.call("runEngine", ["headings", { key: "s1:1", title: "א", origin: "otzaria" }, { key: "s1:2", title: "ב", origin: "otzaria" }, {}], { signal: ac.signal }));
    await vi.advanceTimersByTimeAsync(200);
    ac.abort();
    await vi.advanceTimersByTimeAsync(3 * STUCK_MS);
    expect(await engine).toEqual({ error: "cancelled" });
    expect(lost).toEqual([]);
  });

  it("while a call nobody cancelled is running, a stuck cancelled one waits for it instead of killing it", async () => {
    let release!: () => void;
    const { host, lost } = setup((w) => ({
      // started first, waits (asynchronously) for the cancelled job to let the thread go
      searchBook: (_c, _k, query) => new Promise((r) => (release = () => r({ query, hits: [], scanned: 0, truncated: false }))),
      runEngine: syncEngine(w, 6000),
    }));
    const search = settle(host.call("searchBook", ["s1:1", "של", {}]));
    await vi.advanceTimersByTimeAsync(10);
    const ac = new AbortController();
    void host.call("runEngine", ["headings", { key: "s1:1", title: "א", origin: "otzaria" }, { key: "s1:2", title: "ב", origin: "otzaria" }, {}], { signal: ac.signal }).catch(() => {});
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await vi.advanceTimersByTimeAsync(STUCK_MS + 500);
    expect(lost).toEqual([]); // the search the user still waits for runs in this worker
    await vi.advanceTimersByTimeAsync(2000); // the job ends: the worker answers again
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(await search).toMatchObject({ value: { query: "של" } });
    expect(lost).toEqual([]);
  });

  it("one probe however many calls shared the cancelled signal; finished calls drop their listener", async () => {
    const { host, workers } = setup(() => ({ lines: () => [] }));
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    const all = Promise.all([0, 1, 2].map((i) => host.call("lines", [`s1:${i}`, 0, 10], { signal: ac.signal })));
    await vi.advanceTimersByTimeAsync(100);
    await all;
    expect(remove).toHaveBeenCalledTimes(3);
    ac.abort();
    await vi.advanceTimersByTimeAsync(STUCK_MS * 2);
    // nothing was running: no cancel, no probe
    expect(workers[0]!.seen.filter((m) => m.kind === "cancel" || m.kind === "ping")).toEqual([]);
  });
});
