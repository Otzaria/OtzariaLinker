import type { SourceRegistry } from "../sources/registry";
import { citationsJob } from "./citations-job";
import { batchJob, diffJob, engineJob } from "./engine-job";
import { maxlinkJob } from "./maxlink-job";
import type { CallContext, Handlers } from "./rpc";
import { searchJob } from "./search-job";
import { selfCheck } from "./self-check";
import type { SourcesApi } from "./sources-api";

/*
 * The worker's operations over one registry — the ONLY implementation of SourcesApi. The worker
 * serves it over postMessage (sources.worker.ts); tests and Node tools call it in-process
 * (inProcessCall), so a test exercises exactly the code the worker runs.
 */
const jobCtx = (ctx: CallContext) => ({ signal: ctx.signal, progress: (d: number, n: number) => ctx.progress(d, n) });

export function sourcesHandlers(registry: SourceRegistry): Handlers<SourcesApi> {
  return {
    ping: () => selfCheck(),
    alive: () => true as const,
    open: (ctx, files) => registry.open(files, ctx.signal),
    openMapped: (ctx, token, mapping) => registry.openMapped(token, mapping, jobCtx(ctx)),
    lines: (_ctx, bookKey, from, to) => registry.lines(bookKey, from, to),
    existingLinks: (_ctx, bookKey, from, to) => registry.existingLinks(bookKey, from, to),
    close: (_ctx, sourceId) => registry.close(sourceId),
    diffBooks: (_ctx, oldKey, newKey) => diffJob(registry, oldKey, newKey),
    runBatch: (ctx, engine, pairs, options) => batchJob(registry, engine, pairs, options, jobCtx(ctx)),
    searchBook: (ctx, bookKey, query, options) => searchJob(registry, bookKey, query, options, jobCtx(ctx)),
    runEngine: (ctx, engine, source, target, options) => engineJob(registry, engine, source, target, options, jobCtx(ctx)),
    altToc: (_ctx, bookKey) => registry.altToc(bookKey),
    headings: (_ctx, bookKey) => registry.headings(bookKey),
    runCitations: (ctx, source, options) => citationsJob(registry, source, options, jobCtx(ctx)),
    dbLinkSummary: (ctx, bookKey) => registry.dbLinkSummary(bookKey, jobCtx(ctx)),
    dbLinksPage: (ctx, bookKey, query) => registry.dbLinksPage(bookKey, query, { signal: ctx.signal }),
    runMaxLink: (ctx, steps, options) => maxlinkJob(registry, steps, options, jobCtx(ctx)),
  };
}

/** Calls the handlers directly, in this thread, with the same context the worker would give. */
export function inProcessCall(handlers: Handlers<SourcesApi>): SourcesCall {
  return async (op, args, opts = {}) => {
    const signal = opts.signal ?? new AbortController().signal;
    const handler = handlers[op] as unknown as (ctx: CallContext, ...a: unknown[]) => unknown;
    return (await handler({ signal, progress: (d, n) => opts.onProgress?.(d, n) }, ...(args as unknown[]))) as never;
  };
}

/** One call of SourcesApi, wherever it runs (RpcClient.call has this shape). */
export type SourcesCall = <K extends keyof SourcesApi & string>(
  op: K,
  args: Parameters<SourcesApi[K]>,
  opts?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
) => Promise<Awaited<ReturnType<SourcesApi[K]>>>;
