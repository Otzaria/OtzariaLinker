import { afterEach, describe, expect, it } from "vitest";
import { loadPreferences } from "../../../src/state/preferences";
import type { BooksService, KeyValueStore } from "../../../src/state/services";
import { AppStore } from "../../../src/state/store";
import { syntheticLinksFile, SYNTH_SOURCE } from "../../support/synthetic-links";

/*
 * #42 C5: each autosave of a 100,000-link project was a ~300 ms task 1.5 s after the edit, wherever the user was. The write now
 * waits for an idle moment of the page (requestIdleCallback, with a timeout) — guarded here with a scripted idle callback.
 */
const g = globalThis as { requestIdleCallback?: unknown; cancelIdleCallback?: unknown };
afterEach(() => {
  delete g.requestIdleCallback;
  delete g.cancelIdleCallback;
});
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("the autosave waits for an idle moment (#42 C5)", () => {
  it("nothing is serialized until the page is idle; then the latest state is written once", async () => {
    const idle: { cb: () => void; timeout: number }[] = [];
    const cancelled: number[] = [];
    g.requestIdleCallback = (cb: () => void, o: { timeout: number }) => idle.push({ cb, timeout: o.timeout });
    g.cancelIdleCallback = (id: number) => cancelled.push(id);
    const store = new AppStore({} as BooksService, { save: () => {} }, loadPreferences(null));
    const writes: string[] = [];
    const kv: KeyValueStore = { get: async () => null, set: async (k, v) => void writes.push(`${k}:${JSON.parse(v).links.length}`), delete: async () => {} };
    let serialized = 0;
    const text = store.projectText.bind(store);
    store.projectText = () => (serialized++, text());
    const stop = store.startAutosave(kv, 0);
    await tick();
    store.exchange.importLinksFile(`${SYNTH_SOURCE}_links.json`, syntheticLinksFile(3));
    await tick();
    expect(idle).toHaveLength(1);
    expect(idle[0]!.timeout).toBeGreaterThan(0); // a busy page still saves, a little later
    expect(serialized).toBe(0);
    expect(store.autosave.value).toBe("pending");
    // another change before the page was idle: one write, of the newest state
    store.exchange.importLinksFile(`ספר אחר_links.json`, syntheticLinksFile(2));
    await tick();
    expect(cancelled).toHaveLength(1);
    idle.at(-1)!.cb();
    await tick();
    expect(serialized).toBe(1);
    expect(writes).toEqual(["autosave:v1:5"]);
    expect(store.autosave.value).toBe("saved");
    stop();
  });

  it("without requestIdleCallback (Node, an old browser) it writes after the delay, as before", async () => {
    const store = new AppStore({} as BooksService, { save: () => {} }, loadPreferences(null));
    const writes: string[] = [];
    const kv: KeyValueStore = { get: async () => null, set: async (k) => void writes.push(k), delete: async () => {} };
    const stop = store.startAutosave(kv, 0);
    await tick();
    store.exchange.importLinksFile(`${SYNTH_SOURCE}_links.json`, syntheticLinksFile(3));
    await tick(30);
    expect(writes).toEqual(["autosave:v1"]);
    stop();
  });
});
