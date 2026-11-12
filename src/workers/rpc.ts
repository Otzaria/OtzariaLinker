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
  | { kind: "cancel"; id: number };

export type FromWorker =
  | { kind: "result"; id: number; value: unknown }
  | { kind: "error"; id: number; error: RpcError }
  | { kind: "progress"; id: number; done: number; total: number };

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
        (value) => post(ac.signal.aborted ? { kind: "error", id: m.id, error: { code: "cancelled", message: "הפעולה בוטלה." } } : { kind: "result", id: m.id, value }),
        (err) => post({ kind: "error", id: m.id, error: ac.signal.aborted ? { code: "cancelled", message: "הפעולה בוטלה." } : toRpcError(err) }),
      )
      .finally(() => running.delete(m.id));
  };
}

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export class RpcFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export interface Port {
  postMessage(m: ToWorker): void;
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
}

/** UI side. */
export class RpcClient<A extends Api> {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void; onProgress?: CallOptions["onProgress"] }>();

  constructor(private readonly port: Port) {
    port.onmessage = (e) => this.receive(e.data);
  }

  call<K extends keyof A & string>(op: K, args: Parameters<A[K]>, opts: CallOptions = {}): Promise<Awaited<ReturnType<A[K]>>> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      if (opts.signal?.aborted) return reject(new RpcFailure("cancelled", "הפעולה בוטלה."));
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, ...(opts.onProgress && { onProgress: opts.onProgress }) });
      // reject at once: the UI must never wait on a worker that does not stop (security review #6)
      opts.signal?.addEventListener(
        "abort",
        () => {
          this.port.postMessage({ kind: "cancel", id });
          if (this.pending.delete(id)) reject(new RpcFailure("cancelled", "הפעולה בוטלה."));
        },
        { once: true },
      );
      this.port.postMessage({ kind: "call", id, op, args: args as unknown[] });
    });
  }

  /** Rejects every pending call — the worker died or was replaced. */
  failAll(code: string, message: string): void {
    for (const p of this.pending.values()) p.reject(new RpcFailure(code, message));
    this.pending.clear();
  }

  private receive(m: FromWorker) {
    const p = this.pending.get(m.id);
    if (!p) return;
    if (m.kind === "progress") return p.onProgress?.(m.done, m.total);
    this.pending.delete(m.id);
    if (m.kind === "result") p.resolve(m.value);
    else p.reject(new RpcFailure(m.error.code, m.error.message));
  }
}
