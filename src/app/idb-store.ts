import { macrotask } from "../linking/automatic/steps";
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
  // a compressed write takes a while: the writes and deletes of one key are applied in the order they were asked for
  const last = new Map<string, Promise<unknown>>();
  const inOrder = <T>(k: string, op: () => Promise<T>): Promise<T> => {
    const p = (last.get(k) ?? Promise.resolve()).catch(() => {}).then(op);
    last.set(k, p);
    void p.finally(() => last.get(k) === p && last.delete(k)).catch(() => {});
    return p;
  };
  const put = async (k: string, v: string) => {
    const packed = v.length >= COMPRESS_FROM ? await gzip(v) : null;
    if (packed) {
      try {
        return await run("readwrite", (s) => s.put(packed, k));
      } catch {
        // a browser that does not keep Blobs here (an old private window): the text, as before
      }
    }
    return run("readwrite", (s) => s.put(v, k));
  };
  return {
    get: (k) => run<unknown>("readonly", (s) => s.get(k)).then((v) => (typeof v === "string" ? v : isGzip(v) ? gunzip(v) : null)),
    set: (k, v) => inOrder(k, () => put(k, v)).then(() => {}),
    delete: (k) => inOrder(k, () => run("readwrite", (s) => s.delete(k))).then(() => {}),
    keys: () => run<IDBValidKey[]>("readonly", (s) => s.getAllKeys()).then((ks) => ks.filter((k): k is string => typeof k === "string")),
  };
}

/*
 * A big value (the autosave of a project of 100,000 links is ~50M characters) is stored gzip-compressed, as a Blob (#42 C5):
 * handing IndexedDB the string itself cost a ~200 ms task (it is copied on the page's thread), and it weighed 40+ MB on disk.
 * The text is encoded in slices with a new task between them, and CompressionStream does the compression; the put of the
 * Blob is a fraction of a millisecond. Values written before (strings) are read as they are.
 */
export const COMPRESS_FROM = 1_000_000;
const ENCODE_CHARS = 1 << 19;
const GZIP_TYPE = "application/x-otzaria-linker+gzip";
const isGzip = (v: unknown): v is Blob => typeof Blob === "function" && v instanceof Blob && v.type === GZIP_TYPE;

async function gzip(text: string): Promise<Blob | null> {
  if (typeof CompressionStream !== "function") return null;
  const cs = new CompressionStream("gzip");
  const packed = new Response(cs.readable).blob();
  const writer = cs.writable.getWriter();
  const encoder = new TextEncoder();
  for (let at = 0; at < text.length; ) {
    let end = Math.min(text.length, at + ENCODE_CHARS);
    // never between the two halves of a surrogate pair (each half alone would be written as U+FFFD)
    const c = text.charCodeAt(end - 1);
    if (end < text.length && c >= 0xd800 && c <= 0xdbff) end--;
    await writer.write(encoder.encode(text.slice(at, end)));
    at = end;
    await macrotask();
  }
  await writer.close();
  const blob = await packed;
  return blob.slice(0, blob.size, GZIP_TYPE);
}

const gunzip = (b: Blob): Promise<string> => new Response(b.stream().pipeThrough(new DecompressionStream("gzip"))).text();
