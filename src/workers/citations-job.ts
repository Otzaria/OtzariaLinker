import type { BookRef } from "../core/links/model";
import type { EngineContext, EngineResult } from "../linking/automatic";
import { buildHeadingsIndex, buildRefIndex, CitationRun, type CatalogBook, type CitationsOptions, type TargetIndex } from "../linking/automatic/citations";
import type { SourceRegistry } from "../sources/registry";

/** Lines read per step of the source scan (as the in-book search). */
const CHUNK = 500;
const YIELD_MS = 25;

/*
 * The citations engine in the worker (single-book): reads the SOURCE book chunk by chunk, then
 * loads the index of each book some citation may point to — one book at a time, released before the
 * next — so memory holds one target index and the (small) list of citations, never the library.
 *
 * Progress: the scan is the first half, the target books the second (done/total in per-mille).
 * Keep the signature: the max-linking orchestrator calls it as is.
 */
export async function citationsJob(registry: SourceRegistry, source: BookRef, options: Record<string, unknown>, ctx: EngineContext): Promise<EngineResult> {
  const catalog: CatalogBook[] = (await registry.citationCatalog()).map(({ book, aliases }) => ({
    book: { key: book.key, title: book.title, origin: book.origin, ...(book.isBaseBook !== undefined && { isBaseBook: book.isBaseBook }) },
    aliases,
  }));
  const run = CitationRun.fromCatalog(source, catalog, options as CitationsOptions);
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

/**
 * A cited book's index: its line references when its source has them and they are structured
 * (Sefaria-style "בראשית, א, ב"), else its headings (text files; database books whose references are
 * just "<title> <line>"). Null when the book cannot be read.
 */
async function loadIndex(registry: SourceRegistry, book: BookRef): Promise<{ index: TargetIndex | null; heRefs: Map<number, string> | null }> {
  try {
    const refs = await registry.heRefs(book.key);
    if (refs) {
      const index = buildRefIndex(book, refs);
      if (index) {
        const heRefs = new Map<number, string>();
        for (const r of refs) if (r.heRef) heRefs.set(r.index, r.heRef);
        return { index, heRefs };
      }
    }
    const lines = (await registry.lines(book.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => ({ index: l.index, text: l.anchorText, heading: l.heading, heRef: l.heRef }));
    return { index: buildHeadingsIndex(book, lines), heRefs: null };
  } catch {
    return { index: null, heRefs: null };
  }
}
