import { afterEach, describe, expect, it } from "vitest";
import { idbStore } from "../../../src/app/idb-store";

/*
 * #42 C30 (V7 §1.2): the autosave's IndexedDB. A failed open used to stay cached — one failure (a
 * blocked upgrade, a busy disk) stopped every autosave until the page was refreshed — and `onblocked`
 * was not handled, so the open could wait forever.
 *
 * A minimal in-memory IndexedDB, only what idb-store uses: open (with a scripted outcome per call),
 * one object store, get/put/delete/getAllKeys.
 */
type Outcome = "ok" | "error" | "blocked";
function fakeIndexedDB(outcomes: Outcome[]) {
  const data = new Map<string, unknown>();
  let opens = 0;
  const request = <T>(run: () => T) => {
    const req: { result?: T; error?: Error; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      req.result = run();
      req.onsuccess?.();
    });
    return req;
  };
  const db = {
    onversionchange: null as null | (() => void),
    onclose: null as null | (() => void),
    close() {},
    transaction: () => ({
      objectStore: () => ({
        get: (k: string) => request(() => data.get(k)),
        put: (v: unknown, k: string) => request(() => void data.set(k, v)),
        delete: (k: string) => request(() => void data.delete(k)),
        getAllKeys: () => request(() => [...data.keys()]),
      }),
    }),
  };
  const factory = {
    open() {
      const outcome = outcomes[opens++] ?? "ok";
      const req: { result?: typeof db; error?: Error; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; onupgradeneeded?: () => void } = {};
      queueMicrotask(() => {
        if (outcome === "error") return (req.error = new Error("UnknownError")), req.onerror?.();
        if (outcome === "blocked") return req.onblocked?.(); // and never anything else
        req.result = db;
        req.onsuccess?.();
      });
      return req;
    },
  };
  return { factory, data, opens: () => opens };
}

const g = globalThis as { indexedDB?: unknown };
afterEach(() => void delete g.indexedDB);

describe("idbStore (C30)", () => {
  it("a failed open is not remembered: the next call opens again", async () => {
    const fake = fakeIndexedDB(["error", "ok"]);
    g.indexedDB = fake.factory;
    const kv = idbStore();
    await expect(kv.set("a", "1")).rejects.toThrow();
    await kv.set("a", "2");
    expect(fake.data.get("a")).toBe("2");
    expect(fake.opens()).toBe(2);
  });

  it("an open blocked by another window fails instead of waiting forever, and is tried again", async () => {
    const fake = fakeIndexedDB(["blocked", "ok"]);
    g.indexedDB = fake.factory;
    const kv = idbStore();
    await expect(kv.get("a")).rejects.toThrow();
    await kv.set("a", "x");
    expect(await kv.get("a")).toBe("x");
  });

  it("lists its keys (the autosave finds what closed windows left)", async () => {
    const fake = fakeIndexedDB([]);
    g.indexedDB = fake.factory;
    const kv = idbStore();
    await kv.set("autosave:v1:w:a", "1");
    await kv.set("autosave:v1:w:b", "2");
    expect((await kv.keys!()).sort()).toEqual(["autosave:v1:w:a", "autosave:v1:w:b"]);
  });
});
