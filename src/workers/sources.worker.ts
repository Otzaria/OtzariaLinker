/// <reference lib="webworker" />
/*
 * The sources worker: every open database and text source lives here, so SQLite paging, zstd
 * decompression and file decoding never block the UI. Built as a CLASSIC worker (vite worker.format
 * "iife"): module workers from blob: URLs do not start under file:// in Chrome/Edge (docs/adr/0002).
 */
import { LineContentCodec } from "../database/compression/zstd";
import { loadSqlJs } from "../database/sqlite/sqljs-loader";
import { SourceRegistry } from "../sources/registry";
import { batchJob, diffJob, engineJob } from "./engine-job";
import { serve, type ToWorker } from "./rpc";
import { searchJob } from "./search-job";
import type { SourcesApi } from "./sources-api";

/** A tiny zstd frame of "בדיקת zstd": proves the decoder's WASM starts in this environment. */
const ZSTD_PROBE = new Uint8Array([40, 181, 47, 253, 32, 15, 121, 0, 0, 215, 145, 215, 147, 215, 153, 215, 167, 215, 170, 32, 122, 115, 116, 100]);

declare const self: DedicatedWorkerGlobalScope;

const registry = new SourceRegistry();

const handle = serve<SourcesApi>(
  {
    async ping() {
      const SQL = await loadSqlJs();
      const db = new SQL.Database();
      const sqlite = String(db.exec("select sqlite_version()")[0]?.values[0]?.[0]);
      db.close();
      return { sqlite, zstd: new LineContentCodec([]).decode(ZSTD_PROBE) ?? "" };
    },
    alive: () => true as const,
    open: (ctx, files) => registry.open(files, ctx.signal),
    lines: (_ctx, bookKey, from, to) => registry.lines(bookKey, from, to),
    existingLinks: (_ctx, bookKey, from, to) => registry.existingLinks(bookKey, from, to),
    close: (_ctx, sourceId) => registry.close(sourceId),
    diffBooks: (_ctx, oldKey, newKey) => diffJob(registry, oldKey, newKey),
    runBatch: (ctx, engine, pairs, options) => batchJob(registry, engine, pairs, options, { signal: ctx.signal, progress: (d, n) => ctx.progress(d, n) }),
    searchBook: (ctx, bookKey, query, options) => searchJob(registry, bookKey, query, options, { signal: ctx.signal, progress: (d, n) => ctx.progress(d, n) }),
    runEngine: (ctx, engine, source, target, options) => engineJob(registry, engine, source, target, options, { signal: ctx.signal, progress: (d, n) => ctx.progress(d, n) }),
  },
  (m) => self.postMessage(m),
);

self.onmessage = (e: MessageEvent<ToWorker>) => handle(e.data);
