import type { SourceRegistry } from "../sources/registry";
import { citationsJob } from "./citations-job";
import { batchJob, diffJob, engineJob, titleFitJob } from "./engine-job";
import { fingerprintsJob, maxlinkJob } from "./maxlink-job";
import { RpcFailure, type CallContext, type CallOptions, type Handlers } from "./rpc";
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
    init: (_ctx, idPrefix) => registry.useIdPrefix(idPrefix),
    open: (ctx, files) => registry.open(files, ctx.signal),
    openMapped: (ctx, token, mapping) => registry.openMapped(token, mapping, jobCtx(ctx)),
    testMapping: (ctx, token, mapping) => registry.testMapping(token, mapping, jobCtx(ctx)),
    lines: (_ctx, bookKey, from, to) => registry.lines(bookKey, from, to),
    existingLinks: (_ctx, bookKey, from, to) => registry.existingLinks(bookKey, from, to),
    existingMatchIndexes: (ctx, bookKey, runs) => registry.existingMatchIndexes(bookKey, runs, ctx.signal),
    coverageEnds: (ctx, bookKey) => registry.coverageEnds(bookKey, { signal: ctx.signal }),
    close: (_ctx, sourceId) => registry.close(sourceId),
    titleFit: (ctx, source, target) => titleFitJob(registry, source, target, jobCtx(ctx)),
    diffBooks: (ctx, oldKey, newKey) => diffJob(registry, oldKey, newKey, jobCtx(ctx)),
    runBatch: (ctx, engine, pairs, options) => batchJob(registry, engine, pairs, options, jobCtx(ctx)),
    searchBook: (ctx, bookKey, query, options) => searchJob(registry, bookKey, query, options, jobCtx(ctx)),
    runEngine: (ctx, engine, source, target, options) => engineJob(registry, engine, source, target, options, jobCtx(ctx)),
    altToc: (_ctx, bookKey) => registry.altToc(bookKey),
    headings: (_ctx, bookKey) => registry.headings(bookKey),
    runCitations: (ctx, source, options) => citationsJob(registry, source, options, jobCtx(ctx)),
    dbLinkSummary: (ctx, bookKey) => registry.dbLinkSummary(bookKey, jobCtx(ctx)),
    dbLinksPage: (ctx, bookKey, query) => registry.dbLinksPage(bookKey, query, { signal: ctx.signal }),
    runMaxLink: (ctx, steps, options) => maxlinkJob(registry, steps, options, jobCtx(ctx)),
    fingerprints: (ctx, keys) => fingerprintsJob(registry, keys, jobCtx(ctx)),
  };
}

/** Calls the handlers directly, in this thread, with the same context the worker would give. */
export function inProcessCall(handlers: Handlers<SourcesApi>): SourcesCall {
  return async (op, args, opts = {}) => {
    const signal = opts.signal ?? new AbortController().signal;
    const handler = handlers[op] as unknown as (ctx: CallContext, ...a: unknown[]) => unknown;
    const value = await handler({ signal, progress: (d, n) => opts.onProgress?.(d, n) }, ...(args as unknown[]));
    // as RpcClient: a cancelled call is rejected, unless the caller asked for what it found so far
    if (signal.aborted && !opts.keepPartial) throw new RpcFailure("cancelled", "הפעולה בוטלה.");
    return value as never;
  };
}

/** One call of SourcesApi, wherever it runs (RpcClient.call has this shape). */
export type SourcesCall = <K extends keyof SourcesApi & string>(
  op: K,
  args: Parameters<SourcesApi[K]>,
  opts?: CallOptions,
) => Promise<Awaited<ReturnType<SourcesApi[K]>>>;
