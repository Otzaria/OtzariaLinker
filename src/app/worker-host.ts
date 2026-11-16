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

/*
 * The worker host: one sources worker, replaced when it crashes or when it is stuck in a call the
 * user cancelled (RpcClient's watchdog: the cancelled call had started, the worker does not answer a
 * probe for STUCK_MS, and nothing else the user waits for is running). Replacing it loses the open
 * sources, never the project's links (AppStore.workerLost).
 */
export class WorkerHost {
  private worker!: HostedWorker;
  private rpc!: RpcClient<SourcesApi>;
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
  }
}
