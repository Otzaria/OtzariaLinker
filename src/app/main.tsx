import { effect } from "@preact/signals";
import { render } from "preact";
import { AppStore } from "../state/store";
import type { Saver } from "../state/services";
import { App } from "../ui/app";
import { StoreContext } from "../ui/context";
import { applyTheme } from "../ui/theme/theme";
import "../ui/theme/tokens.css";
import "../ui/theme/app.css";
import { booksService } from "./books-service";
import { hashLocation } from "./hash-location";
import { Router } from "../state/router";
import { idbStore } from "./idb-store";
import { autosaveWindow } from "./autosave-window";
import { WorkerHost, type HostedWorker } from "./worker-host";
import SourcesWorker from "../workers/sources.worker.ts?worker&inline";

/*
 * Composition root: the only place that knows about every layer. It creates the worker, adapts it
 * to the state layer's BooksService, provides a browser download Saver, and renders the UI.
 */
// the sources worker and its watchdog (worker-host.ts): replaced when it crashes or stays stuck in a cancelled call
const host = new WorkerHost(() => new SourcesWorker() as unknown as HostedWorker);

const service = booksService(host.call);

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
host.onLost = (reason) => store.workerLost(reason);
const kv = idbStore();
// each window saves under its own key (#41 B17): a refresh keeps the window's id, a new tab gets its own
void autosaveWindow().then(
  (w) => store.startAutosave(kv, undefined, w),
  () => store.startAutosave(kv, undefined, { id: crypto.randomUUID(), live: async () => null }),
);
// how far a guided flow got (state/guided-flow.ts): a reload or a closed tab can continue it
store.guided.startPersist(kv);
// the max-link job (state/maxlink.ts): a reload or a closed tab can resume it, and re-run only what changed
store.maxLink.startPersist(kv);
// the address follows the screens and dialogs (#/workspace/links, #/help/…), and Back/Forward move between them
new Router(store, hashLocation()).start();

let stopTheme = () => {};
effect(() => {
  stopTheme();
  stopTheme = applyTheme(store.prefs.theme.value);
});
effect(() => document.documentElement.style.setProperty("--font-scale", String(store.prefs.fontScale.value)));

// a self-check the offline E2E test reads: proves the SQLite reader and zstd start in this environment
void host.call("ping", []).then(
  (r) => (document.documentElement.dataset.engine = `${r.sqlite} · ${r.zstd}`),
  (e: Error) => (document.documentElement.dataset.engine = `שגיאה: ${e.message}`),
);
// debugging and E2E hook (no data leaves the page)
(globalThis as { __linker?: AppStore }).__linker = store;
// uncaught errors go to the diagnostic log (saved from the settings menu), never to the network
addEventListener("error", (e) => store.log.error("app.uncaught", e.message, { at: `${String(e.filename ?? "").split("/").pop()}:${e.lineno}:${e.colno}` }));
addEventListener("unhandledrejection", (e) => store.log.error("app.unhandled", String((e.reason as Error | undefined)?.message ?? e.reason)));

render(
  <StoreContext.Provider value={store}>
    <App />
  </StoreContext.Provider>,
  document.getElementById("app")!,
);
