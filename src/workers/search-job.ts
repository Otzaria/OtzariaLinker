import { foldQuery, matchLine, MIN_QUERY, searchLimit, type BookHit, type BookSearchResult } from "../core/text/find";
import type { SourceRegistry } from "../sources/registry";

/** Lines read per step: big enough that the index walk and the page reads amortise, small enough to stay responsive. */
const CHUNK = 500;
/** the scan gives the event loop a turn this often, so a "cancel" message gets through */
const YIELD_MS = 25;

export interface SearchOptions {
  /** most hits returned (default SEARCH_LIMIT, at most SEARCH_MAX_LIMIT) */
  limit?: number;
}

export interface SearchContext {
  signal?: AbortSignal;
  progress?: (done: number, total: number) => void;
}

/**
 * Scans one book for a query (in the worker). The book is read chunk by chunk (registry.scan) and
 * never held whole; matching is on the text the reader shows (the anchor text: in schema 7 it has
 * the footnote bodies), folded by foldForSearch. Reading stops at the first hit past `limit`,
 * which is enough to say "there are more": a common word in a 20k-line book must not ship a huge
 * list to the UI or keep decompressing lines nobody will look at. Cancellable between chunks.
 */
export async function searchJob(registry: SourceRegistry, bookKey: string, query: string, options: SearchOptions = {}, ctx: SearchContext = {}): Promise<BookSearchResult> {
  const folded = foldQuery(query);
  const limit = searchLimit(options.limit);
  const hits: BookHit[] = [];
  let scanned = 0;
  let truncated = false;
  if (folded.length < MIN_QUERY) return { query, hits, scanned, truncated };
  let last = Date.now();
  for await (const chunk of registry.scan(bookKey, CHUNK)) {
    for (const l of chunk.lines) {
      const hit = matchLine(l.anchorText, folded, l.index);
      if (!hit) continue;
      if (hits.length === limit) {
        truncated = true;
        break;
      }
      hits.push(hit);
    }
    scanned += chunk.lines.length;
    if (truncated) break;
    ctx.progress?.(scanned, Math.max(scanned, chunk.total ?? 0));
    if (Date.now() - last > YIELD_MS) {
      await new Promise((r) => setTimeout(r, 0));
      last = Date.now();
    }
    ctx.signal?.throwIfAborted();
  }
  return { query, hits, scanned, truncated };
}
