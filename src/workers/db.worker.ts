/// <reference lib="webworker" />
/*
 * Database worker. Heavy SQLite work runs here so the UI never freezes.
 * Built as a CLASSIC worker (vite worker.format "iife"): module workers from blob: URLs do not
 * start under file:// in Chrome/Edge (docs/adr/0002).
 */
import { loadSqlJs } from "../database/sqlite/sqljs-loader";

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
      reply({ id, ok: true, result: { sqlite: version } });
    }
  } catch (err) {
    reply({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

function reply(r: Response) {
  self.postMessage(r);
}
