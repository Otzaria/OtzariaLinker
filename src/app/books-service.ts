import type { BooksService } from "../state/services";
import type { SourcesCall } from "../workers/sources-handlers";

/*
 * BooksService (what the state layer needs) on top of SourcesApi (what the worker does): the one
 * place that maps the two. The app passes the RPC client's call (main.tsx); tests pass an in-process
 * call over the same handlers (workers/sources-handlers.ts inProcessCall). Adding an operation =
 * SourcesApi + its handler + one line here.
 */
export function booksService(call: SourcesCall): BooksService {
  return {
    open: (files, opts) => call("open", [files], opts),
    openMapped: (token, mapping, opts) => call("openMapped", [token, mapping], opts),
    lines: (key, from, to, opts) => call("lines", [key, from, to], opts),
    existingLinks: (key, from, to, opts) => call("existingLinks", [key, from, to], opts),
    close: async (id) => void (await call("close", [id])),
    runEngine: (engine, source, target, options, opts) => call("runEngine", [engine, source, target, options], opts),
    runBatch: (engine, pairs, options, opts) => call("runBatch", [engine, pairs, options], opts),
    diffBooks: (oldKey, newKey, opts) => call("diffBooks", [oldKey, newKey], opts),
    searchBook: (key, query, options, opts) => call("searchBook", [key, query, options], opts),
    altToc: (key, opts) => call("altToc", [key], opts),
    headings: (key, opts) => call("headings", [key], opts),
    runCitations: (source, options, opts) => call("runCitations", [source, options], opts),
    dbLinkSummary: (key, opts) => call("dbLinkSummary", [key], opts),
    dbLinksPage: (key, query, opts) => call("dbLinksPage", [key, query], opts),
    runMaxLink: (steps, options, opts) => call("runMaxLink", [steps, options], opts),
  };
}
