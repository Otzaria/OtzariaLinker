import type { BookRef } from "../core/links/model";
import { runEngineSliced, type EngineBook, type EngineContext, type EngineId, type EngineResult } from "../linking/automatic";
import { titleFit, type TitleFitReport } from "../linking/title-fit";
import { diffLines, findMoves, type LineFate, type LineMapping } from "../matching/line-diff";
import type { SourceRegistry } from "../sources/registry";

/**
 * Reads both whole books from the registry and runs an engine on them (in the worker), in slices: a
 * cancel stops it at its next line instead of after the whole run (review C3).
 */
export async function engineJob(registry: SourceRegistry, engine: EngineId, source: BookRef, target: BookRef, options: Record<string, unknown>, ctx: EngineContext): Promise<EngineResult> {
  const load = async (book: BookRef): Promise<EngineBook> => ({
    book,
    // anchorText: the line as the generator counts anchor offsets (schema 7: with footnote bodies)
    lines: (await registry.lines(book.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => ({ index: l.index, text: l.anchorText, heading: l.heading, heRef: l.heRef })),
  });
  const s = await load(source);
  const t = await load(target);
  ctx.signal?.throwIfAborted();
  return runEngineSliced(engine, s, t, options, ctx);
}

/** Whether the titles of a commentary fit its base (linking/title-fit.ts), both read here, in the worker. */
export async function titleFitJob(registry: SourceRegistry, source: BookRef, target: BookRef, ctx: EngineContext = {}): Promise<TitleFitReport> {
  const load = async (book: BookRef): Promise<EngineBook> => ({ book, lines: (await registry.lines(book.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => ({ index: l.index, text: l.anchorText, heading: l.heading, heRef: l.heRef })) });
  const s = await load(source);
  ctx.signal?.throwIfAborted();
  const t = await load(target);
  ctx.signal?.throwIfAborted();
  return titleFit(s, t);
}

export interface BatchItem {
  source: BookRef;
  target: BookRef;
  result?: EngineResult;
  /** Hebrew message when this pair failed; the rest of the batch continues */
  error?: string;
}

/**
 * Runs one engine over many pairs, one pair in memory at a time. Progress counts pairs. Cancelled, it
 * stops and returns the pairs done, the last one with what its engine found until then (the engines stop
 * with an "engine/aborted" note); the pairs not reached are not in the list.
 */
export async function batchJob(registry: SourceRegistry, engine: EngineId, pairs: readonly { source: BookRef; target: BookRef }[], options: Record<string, unknown>, ctx: EngineContext): Promise<BatchItem[]> {
  const out: BatchItem[] = [];
  for (const [i, p] of pairs.entries()) {
    if (ctx.signal?.aborted) break;
    ctx.progress?.(i, pairs.length);
    try {
      out.push({ ...p, result: await engineJob(registry, engine, p.source, p.target, options, { ...(ctx.signal && { signal: ctx.signal }) }) });
    } catch (err) {
      if (ctx.signal?.aborted) break;
      out.push({ ...p, error: err instanceof Error ? err.message : String(err) });
    }
  }
  ctx.progress?.(pairs.length, pairs.length);
  return out;
}

export interface BookDiff {
  to: number[];
  fate: LineFate[];
  /** word similarity of each old line to its new line (1 = identical, 0 = none) */
  similarity: number[];
  /** [old, new] of lines moved verbatim (findMoves) — for display and the mapping file only */
  moves: [number, number][];
  /** number of lines of the new edition */
  newLength: number;
  stats: LineMapping["stats"];
}

/**
 * Aligns the lines of two editions of a book (both read here, in the worker). The alignment itself is
 * one synchronous step (bounded: diffLines' maxCells); a cancel is honoured before it (review M6).
 */
export async function diffJob(registry: SourceRegistry, oldKey: string, newKey: string, ctx: EngineContext = {}): Promise<BookDiff> {
  const text = async (key: string) => (await registry.lines(key, 0, Number.MAX_SAFE_INTEGER)).map((l) => l.anchorText);
  const oldLines = await text(oldKey);
  ctx.signal?.throwIfAborted();
  const newLines = await text(newKey);
  ctx.signal?.throwIfAborted();
  const m = diffLines(oldLines, newLines);
  return { to: [...m.to], fate: [...m.fate], similarity: Array.from(m.similarity, (v) => Math.round(v * 1000) / 1000), moves: findMoves(oldLines, newLines, m.to), newLength: newLines.length, stats: m.stats };
}
