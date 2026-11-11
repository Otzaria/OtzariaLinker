import { effect } from "@preact/signals";
import { render } from "preact";
import { AppStore } from "../state/store";
import type { BooksService, Saver } from "../state/services";
import { App } from "../ui/app";
import { StoreContext } from "../ui/context";
import { applyTheme } from "../ui/theme/theme";
import "../ui/theme/tokens.css";
import "../ui/theme/app.css";
import { RpcClient, type Port } from "../workers/rpc";
import { idbStore } from "./idb-store";
import type { SourcesApi } from "../workers/sources-api";
import SourcesWorker from "../workers/sources.worker.ts?worker&inline";

/*
 * Composition root: the only place that knows about every layer. It creates the worker, adapts it
 * to the state layer's BooksService, provides a browser download Saver, and renders the UI.
 */
/*
 * The worker host: one sources worker, replaced when it crashes or when it does not answer a
 * liveness probe a few seconds after a cancel (a cancelled job that keeps running would otherwise
 * block every later request). Replacing it loses the open sources, never the project's links.
 */
let worker!: Worker;
let rpc!: RpcClient<SourcesApi>;
let onLost: (reason: string) => void = () => {};
function startWorker() {
  worker = new SourcesWorker();
  rpc = new RpcClient<SourcesApi>(worker as unknown as Port);
  worker.onerror = (e) => (e.preventDefault(), restartWorker("מנוע הקריאה קרס (ייתכן שקובץ פגום)."));
}
function restartWorker(reason: string) {
  worker.terminate();
  rpc.failAll("worker/restarted", reason);
  startWorker();
  onLost(reason);
}
function watchdog() {
  const timer = setTimeout(() => restartWorker("הפעולה שבוטלה לא נעצרה, ולכן מנוע הקריאה הופעל מחדש."), 4000);
  void rpc.call("alive", []).then(() => clearTimeout(timer), () => {});
}
startWorker();

const call = <K extends keyof SourcesApi & string>(op: K, args: Parameters<SourcesApi[K]>, opts?: { signal?: AbortSignal; onProgress?: (d: number, t: number) => void }) => {
  opts?.signal?.addEventListener("abort", watchdog, { once: true });
  return rpc.call(op, args, opts);
};

const service: BooksService = {
  open: (files, opts) => call("open", [files], opts),
  lines: (key, from, to, opts) => call("lines", [key, from, to], opts),
  existingLinks: (key, from, to, opts) => call("existingLinks", [key, from, to], opts),
  close: async (id) => void (await call("close", [id])),
  runEngine: (engine, source, target, options, opts) => call("runEngine", [engine, source, target, options], opts),
  runBatch: (engine, pairs, options, opts) => call("runBatch", [engine, pairs, options], opts),
  diffBooks: (oldKey, newKey, opts) => call("diffBooks", [oldKey, newKey], opts),
  altToc: (key, opts) => call("altToc", [key], opts),
  headings: (key, opts) => call("headings", [key], opts),
};

const saver: Saver = {
  save(name, data, mime) {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
};

const store = new AppStore(service, saver);
onLost = (reason) => store.workerLost(reason);
store.startAutosave(idbStore());

let stopTheme = () => {};
effect(() => {
  stopTheme();
  stopTheme = applyTheme(store.prefs.theme.value);
});
effect(() => document.documentElement.style.setProperty("--font-scale", String(store.prefs.fontScale.value)));

// a self-check the offline E2E test reads: proves sql.js and zstd start in this environment
void rpc.call("ping", []).then(
  (r) => (document.documentElement.dataset.engine = `SQLite ${r.sqlite} · ${r.zstd}`),
  (e: Error) => (document.documentElement.dataset.engine = `שגיאה: ${e.message}`),
);
// debugging and E2E hook (no data leaves the page)
(globalThis as { __linker?: AppStore }).__linker = store;

render(
  <StoreContext.Provider value={store}>
    <App />
  </StoreContext.Provider>,
  document.getElementById("app")!,
);
