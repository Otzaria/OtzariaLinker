import type { BookRef } from "../core/links/model";
import type { EngineContext, EngineResult } from "../linking/automatic";
import { AliasIndex, buildHeadingsIndex, buildRefIndex, CitationRun, NamedUnitIndex, unitKindOf, unitsFromAltToc, type CatalogBook, type CitationsOptions, type NamedUnit, type NamedUnitSource, type TargetIndex, type UnitKind } from "../linking/automatic/citations";
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
const aliasCache = new WeakMap<SourceRegistry, { sig: string; aliases: AliasIndex; units: NamedUnitIndex }>();
/** another book's own named units (its alt_toc chapters / parshiyot), read when a unit cited by name points into it */
const ownUnitsCache = new WeakMap<SourceRegistry, Map<string, readonly NamedUnit[] | null>>();
const MAX_OWN_UNITS = 300;

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
  const { aliases, units } = await aliasesOf(registry);
  const run = new CitationRun(source, aliases, options as CitationsOptions, units);
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
    const own = run.needsUnits(book) ? await ownUnits(registry, book) : null;
    run.resolveWith(index, book, heRefs ? (line) => heRefs.get(line) ?? null : undefined, own);
    ctx.progress?.(500 + Math.round(((i + 1) / targets.length) * 490), 1000);
    await tick();
  }
  const result = run.finish(ctx.signal ? { signal: ctx.signal } : {});
  ctx.progress?.(1000, 1000);
  return result;
}

/**
 * The alias index of everything open, and the names of the units books cite by name (the chapters of
 * every Bavli tractate, the parshiyot of the Torah: their alt_toc, ~40 books), rebuilt only when the
 * set of open books changed.
 */
async function aliasesOf(registry: SourceRegistry): Promise<{ aliases: AliasIndex; units: NamedUnitIndex }> {
  const books = await registry.citationCatalog();
  const catalog: CatalogBook[] = books.map(({ book, aliases }) => ({
    book: { key: book.key, title: book.title, origin: book.origin, ...(book.isBaseBook !== undefined && { isBaseBook: book.isBaseBook }) },
    aliases,
  }));
  const sig = catalog.map((c) => c.book.key).join("|");
  const hit = aliasCache.get(registry);
  if (hit && hit.sig === sig) return hit;
  const aliases = AliasIndex.build(catalog);
  const sources: NamedUnitSource[] = [];
  for (const { book } of books) {
    const kind = unitKindOf(book.title);
    if (!kind) continue;
    const ref: BookRef = { key: book.key, title: book.title, origin: book.origin };
    sources.push(...(await readUnits(registry, ref, [kind], book.lineCount)));
  }
  const entry = { sig, aliases, units: NamedUnitIndex.build(sources) };
  aliasCache.set(registry, entry);
  ownUnitsCache.delete(registry);
  return entry;
}

/** One book's named units of the given kinds from its source's alt_toc (none: no such structure, or no alt_toc). */
async function readUnits(registry: SourceRegistry, book: BookRef, kinds: readonly UnitKind[], lineCount?: number): Promise<NamedUnitSource[]> {
  try {
    const structures = await registry.altToc(book.key);
    if (!structures?.length) return [];
    // the last unit runs to the end of the book: the declared line count, else the last line with a reference
    const last = lineCount ? lineCount - 1 : ((await registry.heRefs(book.key))?.at(-1)?.index ?? null);
    if (last === null) return [];
    return kinds.map((k) => unitsFromAltToc(book, k, structures, last)).filter((s): s is NamedUnitSource => !!s);
  } catch {
    return [];
  }
}

/**
 * Another book's own named units (its alt_toc chapters and parshiyot), for a unit cited by name in it:
 * a chapter moved to a commentary ("תוס' פ' השולח" → תוספות על גיטין), a parsha of a book arranged by
 * parshiyot ("בשאילתות פרשת אחרי מות").
 */
async function ownUnits(registry: SourceRegistry, book: BookRef): Promise<readonly NamedUnit[] | null> {
  let cache = ownUnitsCache.get(registry);
  if (!cache) ownUnitsCache.set(registry, (cache = new Map()));
  if (cache.has(book.key)) return cache.get(book.key)!;
  const info = (await registry.citationCatalog()).find((x) => x.book.key === book.key)?.book;
  const sources = await readUnits(registry, book, ["chapter", "parsha"], info?.lineCount);
  const units = sources.length ? (NamedUnitIndex.build(sources).byBook.get(book.key) ?? null) : null;
  cache.set(book.key, units);
  while (cache.size > MAX_OWN_UNITS) cache.delete(cache.keys().next().value!);
  return units;
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
