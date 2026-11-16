/*
 * A small typed request/response protocol over postMessage, used between the UI thread and the
 * worker. Every request can be cancelled (stage 3.4 "ביטול פעולות ארוכות") and can report progress.
 * Errors cross the boundary as {code, message} so the UI can show the Hebrew message and branch on
 * the code without depending on Error subclasses (which do not survive structured cloning).
 */

export type Api = Record<string, (...args: never[]) => unknown>;

export interface RpcError {
  code: string;
  message: string;
}

export type ToWorker =
  | { kind: "call"; id: number; op: string; args: unknown[] }
  | { kind: "cancel"; id: number }
  /** liveness probe: answered with "pong" as soon as the worker reads its messages at all */
  | { kind: "ping"; id: number };

export type FromWorker =
  /** the worker read the call and started its handler (a call it has not read is still queued behind other work) */
  | { kind: "started"; id: number }
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; error: RpcError }
  | { kind: "progress"; id: number; done: number; total: number }
  | { kind: "pong"; id: number };

/** What a handler receives besides its arguments. */
export interface CallContext {
  readonly signal: AbortSignal;
  progress(done: number, total: number): void;
}

export type Handlers<A extends Api> = {
  [K in keyof A]: (ctx: CallContext, ...args: Parameters<A[K]>) => Promise<Awaited<ReturnType<A[K]>>> | Awaited<ReturnType<A[K]>>;
};

export function toRpcError(err: unknown): RpcError {
  if (err && typeof err === "object" && "code" in err && "message" in err)
    return { code: String((err as RpcError).code), message: String((err as RpcError).message) };
  if (err instanceof DOMException && err.name === "AbortError") return { code: "cancelled", message: "הפעולה בוטלה." };
  return { code: "internal", message: err instanceof Error ? err.message : String(err) };
}

/** Worker side. `post` is the worker's postMessage. */
export function serve<A extends Api>(handlers: Handlers<A>, post: (m: FromWorker) => void): (m: ToWorker) => void {
  const running = new Map<number, AbortController>();
  return (m) => {
    if (m.kind === "cancel") {
      running.get(m.id)?.abort();
      return;
    }
    if (m.kind === "ping") return post({ kind: "pong", id: m.id });
    post({ kind: "started", id: m.id });
    const handler = handlers[m.op as keyof A];
    if (!handler) {
      post({ kind: "error", id: m.id, error: { code: "rpc/unknown-op", message: `unknown operation ${m.op}` } });
      return;
    }
    const ac = new AbortController();
    running.set(m.id, ac);
    let last = 0;
    const ctx: CallContext = {
      signal: ac.signal,
      progress(done, total) {
        const now = Date.now();
        if (now - last < 100 && done < total) return; // throttle: the UI needs ~10 updates a second at most
        last = now;
        post({ kind: "progress", id: m.id, done, total });
      },
    };
    Promise.resolve()
      .then(() => (handler as (c: CallContext, ...a: unknown[]) => unknown)(ctx, ...m.args))
      .then(
        // a handler that returns after a cancel returns what it found so far (the engines stop with an
        // "engine/aborted" note): it is posted, and a caller that asked for it (keepPartial) gets it
        (value) => post({ kind: "result", id: m.id, value }),
        (err) => post({ kind: "error", id: m.id, error: ac.signal.aborted ? { code: "cancelled", message: "הפעולה בוטלה." } : toRpcError(err) }),
      )
      .finally(() => running.delete(m.id));
  };
}

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /**
   * A cancel asks the worker to stop and waits for what the call found so far (the engines return a
   * partial result with an "engine/aborted" note) instead of rejecting at once — at most PARTIAL_WAIT_MS,
   * and the watchdog still replaces a worker that does not answer. A call that throws on the cancel
   * still rejects with "cancelled".
   */
  keepPartial?: boolean;
}

/** How long a cancelled keepPartial call may take to hand back its partial result before it is rejected. */
export const PARTIAL_WAIT_MS = 10_000;

export class RpcFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface Port {
  postMessage(m: ToWorker): void;
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
}

/**
 * When a call the UI cancelled is still running in the worker and the worker stops answering, the
 * worker is stuck in it: `onStuck` replaces it. Only a call the worker had STARTED counts — a
 * cancelled call still queued behind other work is just waiting (review C3) — and only when no call
 * the user did NOT cancel is running too: that one may be what keeps the worker busy.
 */
export interface Watchdog {
  /** how long the worker may leave a liveness probe unanswered (ms) */
  stuckMs: number;
  onStuck(): void;
}

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onProgress?: CallOptions["onProgress"];
  /** the worker read the call and runs it */
  started: boolean;
  /** removes the abort listener from the caller's signal (a signal may serve many calls) */
  off: () => void;
  keepPartial?: boolean;
  /** cancelled with keepPartial: the worker was asked to stop, and its partial result is awaited */
  stopping?: boolean;
}

/** UI side. */
export class RpcClient<A extends Api> {
  private next = 1;
  private readonly pending = new Map<number, PendingCall>();
  /** calls the UI cancelled that the worker has not finished yet, with whether the worker had started them */
  private readonly cancelled = new Map<number, boolean>();
  /** the liveness probe in flight; `overdue` once it went unanswered for `stuckMs` */
  private probe: { id: number; timer: ReturnType<typeof setTimeout>; overdue: boolean } | null = null;
  private recheck: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly port: Port,
    private readonly watchdog?: Watchdog,
  ) {
    port.onmessage = (e) => this.receive(e.data);
  }

  call<K extends keyof A & string>(op: K, args: Parameters<A[K]>, opts: CallOptions = {}): Promise<Awaited<ReturnType<A[K]>>> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const signal = opts.signal;
      if (signal?.aborted) return reject(new RpcFailure("cancelled", "הפעולה בוטלה."));
      // reject at once: the UI must never wait on a worker that does not stop (security review #6)
      const onAbort = () => this.cancel(id);
      signal?.addEventListener("abort", onAbort, { once: true });
      const off = () => signal?.removeEventListener("abort", onAbort);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, started: false, off, ...(opts.onProgress && { onProgress: opts.onProgress }), ...(opts.keepPartial && { keepPartial: true }) });
      this.port.postMessage({ kind: "call", id, op, args: args as unknown[] });
    });
  }

  /** Rejects every pending call — the worker died or was replaced. The client is not used again. */
  failAll(code: string, message: string): void {
    this.closed = true;
    for (const p of this.pending.values()) (p.off(), p.reject(new RpcFailure(code, message)));
    this.pending.clear();
    this.cancelled.clear();
    if (this.probe) clearTimeout(this.probe.timer);
    clearTimeout(this.recheck);
    this.probe = null;
  }

  private cancel(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    if (p.keepPartial && p.started && !p.stopping) {
      // ask the worker to stop and wait for what it found — never longer than PARTIAL_WAIT_MS
      p.stopping = true;
      this.cancelled.set(id, true);
      this.port.postMessage({ kind: "cancel", id });
      setTimeout(() => this.pending.get(id) === p && (this.pending.delete(id), p.off(), p.reject(new RpcFailure("cancelled", "הפעולה בוטלה.")), this.judge()), PARTIAL_WAIT_MS);
      this.watch();
      this.judge();
      return;
    }
    this.pending.delete(id);
    this.cancelled.set(id, p.started);
    this.port.postMessage({ kind: "cancel", id });
    p.reject(new RpcFailure("cancelled", "הפעולה בוטלה."));
    this.watch();
    this.judge();
  }

  private receive(m: FromWorker) {
    if (this.closed) return;
    if (m.kind === "pong") return this.answered(m.id);
    if (m.kind === "started") {
      const p = this.pending.get(m.id);
      if (p) p.started = true;
      else if (this.cancelled.has(m.id)) (this.cancelled.set(m.id, true), this.watch());
      return;
    }
    const p = this.pending.get(m.id);
    if (m.kind === "progress") return p?.onProgress?.(m.done, m.total);
    // the call is over in the worker
    this.cancelled.delete(m.id);
    if (p) {
      this.pending.delete(m.id);
      p.off();
      if (m.kind === "result") p.resolve(m.value);
      else p.reject(new RpcFailure(m.error.code, m.error.message));
    }
    this.judge();
  }

  /* ---- the watchdog: one probe at a time, however many calls were cancelled ---- */

  private startedCancelled(): boolean {
    for (const started of this.cancelled.values()) if (started) return true;
    return false;
  }

  /** Probes the worker while a cancelled call it had started is not finished. */
  private watch(): void {
    if (!this.watchdog || this.closed || this.probe || !this.startedCancelled()) return;
    const id = this.next++;
    this.probe = { id, overdue: false, timer: setTimeout(() => this.probe?.id === id && ((this.probe.overdue = true), this.judge()), this.watchdog.stuckMs) };
    this.port.postMessage({ kind: "ping", id });
  }

  private answered(id: number): void {
    if (this.probe?.id !== id) return;
    clearTimeout(this.probe.timer);
    this.probe = null;
    // the cancelled call may still run between the worker's slices: probe again until it ends
    clearTimeout(this.recheck);
    if (this.startedCancelled()) this.recheck = setTimeout(() => this.watch(), Math.min(1000, this.watchdog!.stuckMs));
  }

  /** Stuck = the probe is overdue, a started call was cancelled, and nothing the user still waits for runs. */
  private judge(): void {
    if (!this.probe?.overdue || !this.startedCancelled()) return;
    // a call stopping to hand back its partial result is not one the user still waits for to run
    for (const p of this.pending.values()) if (p.started && !p.stopping) return;
    clearTimeout(this.recheck);
    this.probe = null;
    // the host replaces the worker and fails what is still queued (failAll) with its own message
    this.watchdog!.onStuck();
  }
}
