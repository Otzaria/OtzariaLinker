/// <reference lib="webworker" />
/*
 * The sources worker: every open database and text source lives here, so SQLite paging, zstd
 * decompression and file decoding never block the UI. Built as a CLASSIC worker (vite worker.format
 * "iife"): module workers from blob: URLs do not start under file:// in Chrome/Edge (docs/adr/0002).
 */
import { SourceRegistry } from "../sources/registry";
import { serve, type ToWorker } from "./rpc";
import type { SourcesApi } from "./sources-api";
import { sourcesHandlers } from "./sources-handlers";

declare const self: DedicatedWorkerGlobalScope;

const handle = serve<SourcesApi>(sourcesHandlers(new SourceRegistry()), (m) => self.postMessage(m));

self.onmessage = (e: MessageEvent<ToWorker>) => handle(e.data);
