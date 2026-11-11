import type { KeyValueStore } from "../state/services";

/** A tiny IndexedDB key/value store for autosave. Rejects when IndexedDB is missing or blocked. */
export function idbStore(dbName = "otzaria-linker", store = "kv"): KeyValueStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
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
  };
}
