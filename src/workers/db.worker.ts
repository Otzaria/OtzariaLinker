/// <reference lib="webworker" />
/*
 * Database worker. Heavy SQLite work runs here so the UI never freezes.
 * Built as a CLASSIC worker (vite worker.format "iife"): module workers from blob: URLs do not
 * start under file:// in Chrome/Edge (docs/adr/0002).
 */
import { LineContentCodec } from "../database/compression/zstd";
import { loadSqlJs } from "../database/sqlite/sqljs-loader";

/** A tiny zstd frame of "בדיקת zstd": proves the decoder's WASM starts in this environment. */
const ZSTD_PROBE = new Uint8Array([40, 181, 47, 253, 32, 15, 121, 0, 0, 215, 145, 215, 147, 215, 153, 215, 167, 215, 170, 32, 122, 115, 116, 100]);

type Request = { id: number; op: "ping" };
type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, op } = e.data;
  try {
    if (op === "ping") {
      const SQL = await loadSqlJs();
      const db = new SQL.Database();
      const version = db.exec("select sqlite_version()")[0]?.values[0]?.[0];
      db.close();
      const zstd = new LineContentCodec([]).decode(ZSTD_PROBE);
      reply({ id, ok: true, result: { sqlite: version, zstd } });
    }
  } catch (err) {
    reply({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

function reply(r: Response) {
  self.postMessage(r);
}
