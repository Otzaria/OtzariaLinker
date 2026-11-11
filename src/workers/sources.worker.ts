/// <reference lib="webworker" />
/*
 * The sources worker: every open database and text source lives here, so SQLite paging, zstd
 * decompression and file decoding never block the UI. Built as a CLASSIC worker (vite worker.format
 * "iife"): module workers from blob: URLs do not start under file:// in Chrome/Edge (docs/adr/0002).
 */
import { SourceRegistry } from "../sources/registry";
import { citationsJob } from "./citations-job";
import { batchJob, diffJob, engineJob } from "./engine-job";
import { serve, type ToWorker } from "./rpc";
import { searchJob } from "./search-job";
import { selfCheck } from "./self-check";
import { maxlinkJob } from "./maxlink-job";
import type { SourcesApi } from "./sources-api";

declare const self: DedicatedWorkerGlobalScope;

const registry = new SourceRegistry();

const handle = serve<SourcesApi>(
  {
    ping: () => selfCheck(),
    alive: () => true as const,
    open: (ctx, files) => registry.open(files, ctx.signal),
    openMapped: (ctx, token, mapping) => registry.openMapped(token, mapping, { signal: ctx.signal, progress: (d, n) => ctx.progress(d, n) }),
    lines: (_ctx, bookKey, from, to) => registry.lines(bookKey, from, to),
    existingLinks: (_ctx, bookKey, from, to) => registry.existingLinks(bookKey, from, to),
    close: (_ctx, sourceId) => registry.close(sourceId),
    diffBooks: (_ctx, oldKey, newKey) => diffJob(registry, oldKey, newKey),
    runBatch: (ctx, engine, pairs, options) => batchJob(registry, engine, pairs, options, { signal: ctx.signal, progress: (d, n) => ctx.progress(d, n) }),
    searchBook: (ctx, bookKey, query, options) => searchJob(registry, bookKey, query, options, { signal: ctx.signal, progress: (d, n) => ctx.progress(d, n) }),
    runEngine: (ctx, engine, source, target, options) => engineJob(registry, engine, source, target, options, { signal: ctx.signal, progress: (d, n) => ctx.progress(d, n) }),
    altToc: (_ctx, bookKey) => registry.altToc(bookKey),
    headings: (_ctx, bookKey) => registry.headings(bookKey),
    runCitations: (ctx, source, options) => citationsJob(registry, source, options, { signal: ctx.signal, progress: (d, n) => ctx.progress(d, n) }),
    dbLinkSummary: (ctx, bookKey) => registry.dbLinkSummary(bookKey, { signal: ctx.signal, progress: (d, n) => ctx.progress(d, n) }),
    dbLinksPage: (ctx, bookKey, query) => registry.dbLinksPage(bookKey, query, { signal: ctx.signal }),
    runMaxLink: (ctx, steps, options) => maxlinkJob(registry, steps, options, { signal: ctx.signal, progress: (d, n) => ctx.progress(d, n) }),
  },
  (m) => self.postMessage(m),
);

self.onmessage = (e: MessageEvent<ToWorker>) => handle(e.data);
