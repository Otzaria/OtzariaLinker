import type { KeyValueStore } from "../state/services";

/**
 * A tiny IndexedDB key/value store for autosave. Rejects when IndexedDB is missing or blocked.
 *
 * The connection is cached only once it opened (#42 C30): a failed or blocked open is forgotten, so the
 * next save tries again instead of every autosave failing until the page is refreshed. A blocked open
 * (another window holds an older version open) fails at once rather than wait for ever, and a connection
 * another window asks to close (versionchange) or that the browser closed is dropped and reopened.
 */
export function idbStore(dbName = "otzaria-linker", store = "kv"): KeyValueStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(store);
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => (d.close(), (db = null));
        d.onclose = () => (db = null);
        resolve(d);
      };
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
      req.onblocked = () => reject(new Error("IndexedDB open blocked by another window"));
    }).catch((err: unknown) => {
      db = null;
      throw err;
    }));
  const run = <T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>) =>
    open().then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const req = op(d.transaction(store, mode).objectStore(store));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  return {
    get: (k) => run<unknown>("readonly", (s) => s.get(k)).then((v) => (typeof v === "string" ? v : null)),
    set: (k, v) => run("readwrite", (s) => s.put(v, k)).then(() => {}),
    delete: (k) => run("readwrite", (s) => s.delete(k)).then(() => {}),
    keys: () => run<IDBValidKey[]>("readonly", (s) => s.getAllKeys()).then((ks) => ks.filter((k): k is string => typeof k === "string")),
  };
}
