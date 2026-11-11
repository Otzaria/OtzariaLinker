import type { BookRef } from "../core/links/model";
import type { EngineContext, EngineResult } from "../linking/automatic";
import { AliasIndex, buildHeadingsIndex, buildRefIndex, CitationRun, type CatalogBook, type CitationsOptions, type TargetIndex } from "../linking/automatic/citations";
import type { SourceRegistry } from "../sources/registry";

/** Lines read per step of the source scan (as the in-book search). */
const CHUNK = 500;
const YIELD_MS = 25;
/**
 * Target indexes kept between runs, per registry (LRU), bounded by the lines they cover. An index
 * holds numbers, short labels and the lines' references, never their text (~60 bytes a line), so
 * 400K lines stay near 25 MB, and a second book that cites the same Talmud and Tanakh (every book
 * does) does not read them again.
 */
const MAX_CACHED_LINES = 400_000;

interface Loaded {
  index: TargetIndex | null;
  heRefs: Map<number, string> | null;
  /** lines the entry covers (its weight in the cache) */
  weight: number;
}
const indexCache = new WeakMap<SourceRegistry, Map<string, Loaded>>();
const aliasCache = new WeakMap<SourceRegistry, { sig: string; aliases: AliasIndex }>();

/*
 * The citations engine in the worker (single-book): reads the SOURCE book chunk by chunk, then
 * resolves its citations against the index of each book some citation may point to — one book at a
 * time — so memory holds the (small) list of citations and a bounded set of indexes, never the
 * library's text.
 *
 * Progress: the scan is the first half, the target books the second (done/total in per-mille).
 * Keep the signature: the max-linking orchestrator calls it as is.
 */
export async function citationsJob(registry: SourceRegistry, source: BookRef, options: Record<string, unknown>, ctx: EngineContext): Promise<EngineResult> {
  const run = new CitationRun(source, await aliasesOf(registry), options as CitationsOptions);
  let last = Date.now();
  const tick = async () => {
    if (Date.now() - last > YIELD_MS) {
      await new Promise((r) => setTimeout(r, 0));
      last = Date.now();
    }
    ctx.signal?.throwIfAborted();
  };
  let scanned = 0;
  for await (const chunk of registry.scan(source.key, CHUNK)) {
    run.scan(chunk.lines.map((l) => ({ index: l.index, text: l.anchorText, heading: l.heading })));
    scanned += chunk.lines.length;
    const total = Math.max(scanned, chunk.total ?? 0);
    ctx.progress?.(Math.round((scanned / total) * 500), 1000);
    await tick();
  }
  const targets = run.targets();
  for (const [i, book] of targets.entries()) {
    const { index, heRefs } = await loadIndex(registry, book);
    run.resolveWith(index, book, heRefs ? (line) => heRefs.get(line) ?? null : undefined);
    ctx.progress?.(500 + Math.round(((i + 1) / targets.length) * 490), 1000);
    await tick();
  }
  const result = run.finish(ctx.signal ? { signal: ctx.signal } : {});
  ctx.progress?.(1000, 1000);
  return result;
}

/** The alias index of everything open, rebuilt only when the set of open books changed. */
async function aliasesOf(registry: SourceRegistry): Promise<AliasIndex> {
  const catalog: CatalogBook[] = (await registry.citationCatalog()).map(({ book, aliases }) => ({
    book: { key: book.key, title: book.title, origin: book.origin, ...(book.isBaseBook !== undefined && { isBaseBook: book.isBaseBook }) },
    aliases,
  }));
  const sig = catalog.map((c) => c.book.key).join("|");
  const hit = aliasCache.get(registry);
  if (hit && hit.sig === sig) return hit.aliases;
  const aliases = AliasIndex.build(catalog);
  aliasCache.set(registry, { sig, aliases });
  return aliases;
}

/**
 * A cited book's index: its line references when its source has them and they are structured
 * (Sefaria-style "בראשית, א, ב"), else its headings (text files; database books whose references are
 * just "<title> <line>"). Null when the book cannot be read.
 */
async function loadIndex(registry: SourceRegistry, book: BookRef): Promise<Loaded> {
  let cache = indexCache.get(registry);
  if (!cache) indexCache.set(registry, (cache = new Map()));
  let total = 0;
  for (const v of cache.values()) total += v.weight;
  const hit = cache.get(book.key);
  if (hit) {
    cache.delete(book.key);
    cache.set(book.key, hit);
    return hit;
  }
  let loaded: Loaded;
  try {
    const refs = await registry.heRefs(book.key);
    const refIndex = refs ? buildRefIndex(book, refs) : null;
    if (refs && refIndex) {
      const heRefs = new Map<number, string>();
      for (const r of refs) if (r.heRef) heRefs.set(r.index, r.heRef);
      loaded = { index: refIndex, heRefs, weight: refs.length };
    } else {
      const lines = (await registry.lines(book.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => ({ index: l.index, text: l.anchorText, heading: l.heading, heRef: l.heRef }));
      loaded = { index: buildHeadingsIndex(book, lines), heRefs: null, weight: lines.length };
    }
  } catch {
    // a closed source or an unreadable book: its citations are reported as unresolved (not cached)
    return { index: null, heRefs: null, weight: 0 };
  }
  cache.set(book.key, loaded);
  total += loaded.weight;
  while (total > MAX_CACHED_LINES && cache.size > 1) {
    const oldest = cache.keys().next().value!;
    total -= cache.get(oldest)!.weight;
    cache.delete(oldest);
  }
  return loaded;
}
