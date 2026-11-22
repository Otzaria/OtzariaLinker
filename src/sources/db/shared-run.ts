/*
 * One computation that several callers wait for at once (a book's link listing, the scan of external_link). It
 * has its OWN AbortController: a caller that gives up (its signal aborts) leaves, and the work is cancelled only
 * when every caller that could be cancelled has left — a caller without a signal never leaves, so the work runs on
 * for it. Before this, the work was bound to the FIRST caller's signal, and cancelling that caller rejected a
 * second one that had asked for nothing of the kind (QA round 2, H2).
 */
export type Progress = (done: number, total: number) => void;
export interface RunContext {
  signal?: AbortSignal;
  progress?: Progress;
}

export class SharedRun<T> {
  private readonly ctl = new AbortController();
  private readonly listeners = new Set<Progress>();
  private waiters = 0;
  private settled = false;
  /** the work itself, for a handler that must not count as a caller (the cache's cleanup) */
  readonly result: Promise<T>;

  constructor(start: (ctx: { signal: AbortSignal; progress: Progress }) => Promise<T>) {
    this.result = start({ signal: this.ctl.signal, progress: (done, total) => this.listeners.forEach((f) => f(done, total)) });
    const settle = () => void (this.settled = true);
    this.result.then(settle, settle);
  }

  /** the work was cancelled (everyone left): a new caller must start it again */
  get cancelled(): boolean {
    return this.ctl.signal.aborted;
  }

  /** Waits for the result as one more caller. */
  join(ctx: RunContext = {}): Promise<T> {
    this.waiters++;
    if (ctx.progress) this.listeners.add(ctx.progress);
    const signal = ctx.signal;
    if (!signal) return this.result;
    const leave = () => {
      if (ctx.progress) this.listeners.delete(ctx.progress);
      if (--this.waiters === 0 && !this.settled) this.ctl.abort();
    };
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        leave();
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        leave();
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.result.then(
        (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
        (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
      );
    });
  }
}
