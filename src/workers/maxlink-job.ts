import type { BookRef } from "../core/links/model";
import { runEngine, type EngineBook, type EngineContext, type EngineResult } from "../linking/automatic";
import type { MaxLinkJobResult, StepResult } from "../linking/maxlink-report";
import { linePairKey } from "../linking/merge";
import type { PlanStep, SingleEngineId } from "../linking/plan";
import type { SourceRegistry } from "../sources/registry";

/*
 * Runs a max-link plan in the worker (stage 8.4): the steps one after another, with progress over
 * all of them, cancellable, and with bounded memory — the two books of a pair are read once for
 * every engine of that pair and dropped before the next pair, as batchJob does. A failing step is
 * recorded and the rest run. Merging happens in the state layer (linking/merge.ts), which also knows
 * the project's links.
 */

/** A single-book engine's job: read one book (and whatever else it needs from the registry) and suggest links. */
export type SingleRunner = (registry: SourceRegistry, source: BookRef, options: Record<string, unknown>, ctx: EngineContext) => Promise<EngineResult>;

/**
 * Runners of the single-book engines, by engine id. The type demands one for every registered engine
 * that is not a pair engine (linking/plan.ts), so registering an engine there without its runner does
 * not compile. The citations engine registers here:
 *   citations: citationsJob,
 */
export const SINGLE_BOOK_RUNNERS: Record<SingleEngineId, SingleRunner> = {};

export interface MaxLinkJobOptions {
  /** per-engine options (advanced mode); absent = the engine's defaults */
  engineOptions?: Partial<Record<string, Record<string, unknown>>>;
}

/** units of progress per step: engines report their own progress inside a step */
const UNIT = 1000;

export async function maxlinkJob(
  registry: SourceRegistry,
  steps: readonly PlanStep[],
  options: MaxLinkJobOptions,
  ctx: EngineContext,
  runners: Partial<Record<string, SingleRunner>> = SINGLE_BOOK_RUNNERS,
): Promise<MaxLinkJobResult> {
  // steps of the same pair next to each other, so the pair is read once; otherwise the plan's order
  const order = new Map<string, number>();
  const pairKey = (s: PlanStep) => (s.kind === "pair" ? `${s.source.key}>${s.target.key}` : `single:${s.id}`);
  steps.forEach((s) => order.has(pairKey(s)) || order.set(pairKey(s), order.size));
  const sorted = [...steps].sort((a, b) => order.get(pairKey(a))! - order.get(pairKey(b))!);
  const focusBooks = [...new Set(steps.map((s) => s.source.key))];
  const total = (steps.length + focusBooks.length) * UNIT;
  const optionsOf = (engine: string) => options.engineOptions?.[engine] ?? {};
  const items: StepResult[] = [];

  let loaded = null as { key: string; source: EngineBook; target: EngineBook } | null;
  let loadError = null as { key: string; message: string } | null;
  for (const [i, step] of sorted.entries()) {
    ctx.signal?.throwIfAborted();
    ctx.progress?.(i * UNIT, total);
    const inner: EngineContext = {
      ...(ctx.signal && { signal: ctx.signal }),
      progress: (d, n) => ctx.progress?.(i * UNIT + (n > 0 ? Math.min(UNIT - 1, Math.floor((d / n) * UNIT)) : 0), total),
    };
    const t0 = Date.now();
    try {
      let result: EngineResult;
      if (step.kind === "pair") {
        const key = pairKey(step);
        if (loadError?.key === key) throw new Error(loadError.message);
        if (loaded?.key !== key) {
          loaded = null; // drop the previous pair before reading the next one
          try {
            loaded = { key, source: await load(registry, step.source), target: await load(registry, step.target) };
          } catch (err) {
            if (ctx.signal?.aborted) throw err;
            loadError = { key, message: messageOf(err) };
            throw err;
          }
        }
        ctx.signal?.throwIfAborted();
        result = runEngine(step.engine, loaded.source, loaded.target, optionsOf(step.engine), inner);
      } else {
        loaded = null;
        const run = runners[step.engine];
        if (!run) throw new Error(`השיטה "${step.engine}" אינה זמינה בגרסה הזו.`);
        result = await run(registry, step.source, optionsOf(step.engine), inner);
      }
      items.push({ stepId: step.id, result: { ...result, unmatched: [] }, unmatched: result.unmatched.length, ms: Date.now() - t0 });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      items.push({ stepId: step.id, unmatched: 0, error: messageOf(err), ms: Date.now() - t0 });
    }
  }
  loaded = null;

  // the links the library already has, for every book a step read from (both directions: atLines)
  const keys = new Set<string>();
  for (const [j, key] of focusBooks.entries()) {
    ctx.signal?.throwIfAborted();
    ctx.progress?.((steps.length + j) * UNIT, total);
    try {
      for (const l of await registry.existingLinks(key, 0, Number.MAX_SAFE_INTEGER)) keys.add(linePairKey(l));
    } catch {
      /* a source without links (text files) or a read error: nothing to compare with */
    }
  }
  ctx.progress?.(total, total);
  // back in the plan's order
  const pos = new Map(steps.map((s, i) => [s.id, i]));
  items.sort((a, b) => pos.get(a.stepId)! - pos.get(b.stepId)!);
  return { items, dbLinkKeys: [...keys] };
}

async function load(registry: SourceRegistry, book: BookRef): Promise<EngineBook> {
  // anchorText: the line as the generator counts anchor offsets (schema 7: with footnote bodies)
  return { book, lines: (await registry.lines(book.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => ({ index: l.index, text: l.anchorText, heading: l.heading, heRef: l.heRef })) };
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
