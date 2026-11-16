import { RpcClient, type Port } from "../workers/rpc";
import type { SourcesApi } from "../workers/sources-api";
import type { SourcesCall } from "../workers/sources-handlers";

/** What the host needs of a worker (a DOM Worker has it; tests pass an in-process one). */
export interface HostedWorker extends Port {
  terminate(): void;
  onerror: ((e: { preventDefault(): void }) => void) | null;
}

/** How long a worker may leave a liveness probe unanswered after a cancel before it is replaced. */
export const STUCK_MS = 4000;

/**
 * The source-id prefix of the n-th worker: "s" for the first (ids s1, s2…), "s<n>." after a restart
 * (s2.1, s2.2…). Ids never repeat across workers, so a key like "s1:7" kept anywhere in the UI after a
 * restart names a closed source and never another book (review C2).
 */
export const sourceIdPrefix = (generation: number): string => (generation === 1 ? "s" : `s${generation}.`);

/*
 * The worker host: one sources worker, replaced when it crashes or when it is stuck in a call the
 * user cancelled (RpcClient's watchdog: the cancelled call had started, the worker does not answer a
 * probe for STUCK_MS, and nothing else the user waits for is running). Replacing it loses the open
 * sources, never the project's links (AppStore.workerLost). The source ids are the host's: each worker
 * is told its prefix before any other call.
 */
export class WorkerHost {
  private worker!: HostedWorker;
  private rpc!: RpcClient<SourcesApi>;
  private generation = 0;
  /** called after a replacement, with the Hebrew reason */
  onLost: (reason: string) => void = () => {};

  constructor(
    private readonly spawn: () => HostedWorker,
    private readonly stuckMs = STUCK_MS,
  ) {
    this.start();
  }

  readonly call: SourcesCall = (op, args, opts) => this.rpc.call(op, args, opts);

  restart(reason: string): void {
    this.worker.terminate();
    this.rpc.failAll("worker/restarted", reason);
    this.start();
    this.onLost(reason);
  }

  private start(): void {
    const worker = (this.worker = this.spawn());
    const rpc = (this.rpc = new RpcClient<SourcesApi>(worker, {
      stuckMs: this.stuckMs,
      onStuck: () => this.rpc === rpc && this.restart("הפעולה שבוטלה לא נעצרה, ולכן מנוע הקריאה הופעל מחדש."),
    }));
    worker.onerror = (e) => (e.preventDefault(), this.worker === worker && this.restart("מנוע הקריאה קרס (ייתכן שקובץ פגום)."));
    // first message of the worker: read before any open (the worker handles messages in order)
    void rpc.call("init", [sourceIdPrefix(++this.generation)]).catch(() => {});
  }
}
