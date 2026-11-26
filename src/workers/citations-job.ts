import type { BookRef } from "../core/links/model";
import { compileForEngine, LineGate, SOURCE_FILTER_OPTION, type EngineContext, type EngineLine, type EngineResult } from "../linking/automatic";
import { AliasIndex, dafStructureFromAltToc, type DafStructure, buildHeadingsIndex, buildRefIndex, CitationRun, NamedUnitIndex, unitKindOf, unitsFromAltToc, type CatalogBook, type CitationsOptions, type NamedUnit, type NamedUnitSource, type TargetIndex, type UnitKind, citationGate } from "../linking/automatic/citations";
import type { SourceRegistry } from "../sources/registry";

/** Lines read per step of the source scan (as the in-book search). */
const CHUNK = 500;
const YIELD_MS = 25;
/** how long the target books may still be read after a cancel, to rank what the scan found (below rpc.ts PARTIAL_WAIT_MS) */
const RESOLVE_AFTER_CANCEL_MS = 3_000;
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
/** a book's printed pagination (alt_toc "דפים"), read when a citation of it by daf needs it */
const pagesCache = new WeakMap<SourceRegistry, Map<string, DafStructure | null>>();
const MAX_PAGES = 50;

/**
 * Drops what the caches hold for the books of a closed source (V7 round 2, item 10). Their keys are never asked again (a source
 * opened again gets new keys), yet the target indexes stayed until the line budget pushed them out: a run of 10 books on seforim.db
 * left ~240 MB of them on the heap after the database was closed (docs/reviews/V7_PERFORMANCE.md §9.4). The catalog's aliases are
 * built from the open books, so they go too.
 */
export function forgetCitationSource(registry: SourceRegistry, sourceId: string): void {
  const mine = (key: string) => key.startsWith(`${sourceId}:`);
  for (const cache of [indexCache.get(registry), ownUnitsCache.get(registry), pagesCache.get(registry)]) if (cache) for (const k of [...cache.keys()]) if (mine(k)) cache.delete(k);
  aliasCache.delete(registry);
}

/** The book keys the citations caches hold (for tests and diagnostics). */
export function cachedCitationBooks(registry: SourceRegistry): string[] {
  return [indexCache.get(registry), ownUnitsCache.get(registry), pagesCache.get(registry)].flatMap((c) => [...(c?.keys() ?? [])]);
}

/*
 * The citations engine in the worker (single-book): reads the SOURCE book chunk by chunk, then
 * resolves its citations against the index of each book some citation may point to — one book at a
 * time — so memory holds the (small) list of citations and a bounded set of indexes, never the
 * library's text.
 *
 * Progress: the scan is the first half, the target books the second (done/total in per-mille).
 * Keep the signature: the max-linking orchestrator calls it as is.
 */
export async function citationsJob(registry: SourceRegistry, source: BookRef, allOptions: Record<string, unknown>, ctx: EngineContext): Promise<EngineResult> {
  // the run's line filter (issue #27, findings #40 A1; source-filter.ts LineGate): an excluded line is still READ, as context — a "שם" or
  // a bare "פרק ג" on the next included line refers to the place the excluded line cited (V7 PR2 review, finding 2: blanking it sent
  // "[ב] (שם, ג)" after "א) (בראשית ב, ב)" to בראשית א, ג at "high") — and the guard drops every suggestion and unmatched line of it
  const { [SOURCE_FILTER_OPTION]: rawFilter, ...options } = allOptions;
  const gate = rawFilter === undefined ? null : new LineGate(source.key, compileForEngine(rawFilter, "citations"), false);
  const result = await citationsRun(registry, source, options, ctx, gate);
  if (!gate) return result;
  const guarded = gate.guard(result);
  return { ...guarded, notes: [gate.note(), ...guarded.notes] };
}

async function citationsRun(registry: SourceRegistry, source: BookRef, options: Record<string, unknown>, ctx: EngineContext, gate: LineGate | null): Promise<EngineResult> {
  // not without a reason (2.1): a book with no sign of a place in it (suitability.ts CITATION_GATE: one line with a place word and a number, or with the
  // name of an open book and two numbers) has little to find. The look stops as soon as the gate opens, so a book with references pays one
  // chunk; one without pays a read of its lines, far below the scanner. A user who knows better runs it anyway (CitationsOptions.noGate).
  // the catalog of every open book takes seconds on the whole library: the bar says so from the start (#41 B11; the stage text: state/suggestions.ts)
  ctx.progress?.(0, 1000);
  const aborted = () => ctx.signal?.aborted === true;
  const { aliases, units } = await aliasesOf(registry, aborted);
  // a cancel while preparing stops here, saying so — no line of the book was read, so there is nothing partial to rank
  const stopped = (): EngineResult => ({ suggestions: [], notes: [{ code: "engine/aborted", text: "החיפוש נעצר בשלב ההכנה, לפני שנקראה שורה מהספר, ולכן אין הצעות. כדי לחפש, הריצו שוב." }], unmatched: [] });
  if (aborted()) return stopped();
  const gateOpen = (options as CitationsOptions).noGate === true || (await showsReferences(registry, source, (key) => aliases.hasFirstWord(key)));
  if (aborted()) return stopped();
  if (!gateOpen) {
    ctx.progress?.(1000, 1000);
    return {
      suggestions: [],
      notes: [{ code: "citations/skipped-no-references", text: `בספר "${source.title}" אין סימן ברור של הפניה (שורה עם דף, פרק, סימן, סעיף או פסוק ומספר, או שם של ספר פתוח ושני מספרים כמו "בראשית א, ב"), ולכן שיטת מראי המקומות לא הורצה עליו. ספר שמצטט בצורה אחרת ייתכן שנדלג בטעות: אפשר להריץ אותו בכל זאת באפשרות "להריץ גם על ספר בלי סימני הפניה".` }],
      unmatched: [],
    };
  }
  const run = new CitationRun(source, aliases, options as CitationsOptions, units);
  let last = Date.now();
  // a cancel (or the benchmark's time cap) stops the scan and the resolution, never throws: finish() still ranks
  // the citations of the books already read, with an "engine/aborted" note — partial results survive (as the
  // other engines return theirs)
  const tick = async () => {
    if (Date.now() - last > YIELD_MS) {
      await new Promise((r) => setTimeout(r, 0));
      last = Date.now();
    }
  };
  let scanned = 0;
  for await (const chunk of registry.scan(source.key, CHUNK)) {
    run.scan(chunk.lines.map((l): EngineLine => {
      const line: EngineLine = { index: l.index, text: l.anchorText, heading: l.heading, heRef: l.heRef };
      return gate ? gate.judge(line) : line;
    }));
    scanned += chunk.lines.length;
    const total = Math.max(scanned, chunk.total ?? 0);
    ctx.progress?.(Math.round((scanned / total) * 500), 1000);
    await tick();
    if (aborted()) break;
  }
  const targets = run.targets();
  // a scan cut short by a cancel still checks the books it named for a short while (#41 B11): what it recognised becomes a partial
  // result instead of nothing, and the cancel still answers well within the UI's wait (rpc.ts PARTIAL_WAIT_MS). A cancel during this
  // stage stops at the next book: the books already checked are the partial result.
  const cancelledAt = aborted() ? Date.now() : 0;
  for (const [i, book] of targets.entries()) {
    if (cancelledAt ? Date.now() - cancelledAt > RESOLVE_AFTER_CANCEL_MS : aborted()) break;
    const { index, heRefs } = await loadIndex(registry, book);
    const own = run.needsUnits(book) ? await ownUnits(registry, book) : null;
    const pages = run.wantsPages(book, index) ? await pagesOf(registry, book) : null;
    run.resolveWith(index, book, heRefs ? (line) => heRefs.get(line) ?? null : undefined, own, pages);
    // "תוס' … ד"ה רבי מאיר": the commentator's amud, read to find the line of the ד"ה (a few dozen lines each)
    for (const span of mergeSpans(run.diburSpans(book))) {
      const lines = await registry.lines(book.key, span.line, span.end);
      run.refineDibur(book, lines.map((l) => ({ index: l.index, text: l.anchorText })), heRefs ? (line) => heRefs.get(line) ?? null : undefined);
    }
    ctx.progress?.(500 + Math.round(((i + 1) / targets.length) * 490), 1000);
    await tick();
  }
  const result = run.finish(ctx.signal ? { signal: ctx.signal } : {});
  ctx.progress?.(1000, 1000);
  return result;
}

/** Whether the book shows the signs of references the gate asks for (suitability.ts CITATION_GATE); true when the read fails or is cancelled (then the engine decides). */
async function showsReferences(registry: SourceRegistry, source: BookRef, knowsName: (key: string) => boolean): Promise<boolean> {
  try {
    const gate = citationGate(knowsName);
    for await (const chunk of registry.scan(source.key, CHUNK)) for (const l of chunk.lines) if (l.heading === null && gate.add(l.anchorText)) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * The alias index of everything open, and the names of the units books cite by name (the chapters of
 * every Bavli tractate, the parshiyot of the Torah: their alt_toc, ~40 books), rebuilt only when the
 * set of open books changed.
 */
async function aliasesOf(registry: SourceRegistry, aborted: () => boolean = () => false): Promise<{ aliases: AliasIndex; units: NamedUnitIndex }> {
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
    // cancelled: the caller stops before using it, and an incomplete index is never cached
    if (aborted()) return { aliases, units: NamedUnitIndex.build([]) };
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

/** overlapping line spans as one (each amud is read once) */
function mergeSpans(spans: readonly { line: number; end: number }[]): { line: number; end: number }[] {
  const out: { line: number; end: number }[] = [];
  for (const s of [...spans].sort((a, b) => a.line - b.line)) {
    const last = out.at(-1);
    if (last && s.line <= last.end + 1) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

/** A book's printed pagination from its alt_toc ("Daf Zohar"), or null; cached per registry. */
async function pagesOf(registry: SourceRegistry, book: BookRef): Promise<DafStructure | null> {
  let cache = pagesCache.get(registry);
  if (!cache) pagesCache.set(registry, (cache = new Map()));
  if (cache.has(book.key)) return cache.get(book.key)!;
  let ds: DafStructure | null = null;
  try {
    const structures = await registry.altToc(book.key);
    if (structures?.length) {
      const info = (await registry.citationCatalog()).find((x) => x.book.key === book.key)?.book;
      const last = info?.lineCount ? info.lineCount - 1 : ((await registry.heRefs(book.key))?.at(-1)?.index ?? null);
      if (last !== null) ds = dafStructureFromAltToc(book, structures, last);
    }
  } catch {
    ds = null;
  }
  cache.set(book.key, ds);
  while (cache.size > MAX_PAGES) cache.delete(cache.keys().next().value!);
  return ds;
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
