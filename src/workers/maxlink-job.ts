import type { BookRef } from "../core/links/model";
import { runEngine, type Confidence, type EngineBook, type EngineContext, type EngineResult, type Reason } from "../linking/automatic";
import type { MaxLinkJobResult, StepResult } from "../linking/maxlink-report";
import { linePairKey } from "../linking/merge";
import type { PlanStep, SingleEngineId } from "../linking/plan";
import { sectionFor } from "../linking/sections";
import type { SourceRegistry } from "../sources/registry";
import { citationsJob } from "./citations-job";

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
 * not compile.
 */
export const SINGLE_BOOK_RUNNERS: Record<SingleEngineId, SingleRunner> = {
  citations: citationsJob,
};

export interface MaxLinkJobOptions {
  /** per-engine options (advanced mode); absent = the engine's defaults */
  engineOptions?: Partial<Record<string, Record<string, unknown>>>;
}

/** units of progress per step: engines report their own progress inside a step */
const UNIT = 1000;

/**
 * A pair step. When the dependant is written on several bases (Relation.scope), only the part of it
 * headed by this base is read (linking/sections.ts); headings' "high" there is left for review (a
 * range to a whole chapter of a section was right in 6 of 313 on the real database). Without such a
 * part only dibur-hamatchil runs, on the whole book, and nothing it finds is above "possible": its
 * windows come from headings that may follow another base's numbering. Measurements:
 * docs/AUTOMATION_ENGINE.md §5.1, tests/validation/multibase.test.ts.
 */
function runScoped(step: Extract<PlanStep, { kind: "pair" }>, source: EngineBook, target: EngineBook, options: Record<string, unknown>, ctx: EngineContext): EngineResult {
  const scope = step.relation.scope;
  if (!scope) return runEngine(step.engine, source, target, options, ctx);
  const section = sectionFor(source, scope.section);
  if (section) {
    let r = runEngine(step.engine, section.book, target, options, ctx);
    if (step.engine === "headings") r = capConfidence(r, ["high"], { code: "maxlink/section-high", text: "קישור לפרק שלם בתוך חלק של ספר על כמה ספרים: לבדיקה." });
    const note: Reason = { code: "maxlink/section", text: `רק החלק "${section.heading}" של "${source.book.title}" (${section.lines.toLocaleString("he")} שורות) קושר אל "${target.book.title}".` };
    return { ...r, notes: [note, ...r.notes] };
  }
  if (step.engine !== "dibur-hamatchil")
    return { suggestions: [], notes: [{ code: "maxlink/no-section", text: `בספר "${source.book.title}" אין חלק בשם "${target.book.title}", ולכן שיטה זו לא רצה עליו.` }], unmatched: [] };
  const r = capConfidence(runEngine(step.engine, source, target, options, ctx), ["certain", "high"], { code: "maxlink/dh-only", text: `בספר אין חלק בשם "${target.book.title}": המילים נמצאו בטקסט, אבל המקום לא מאומת בכותרות. לבדיקה.` });
  const note: Reason = { code: "maxlink/dh-only", text: `בספר "${source.book.title}" אין חלק בשם "${target.book.title}", ולכן רק דיבור המתחיל קישר אליו, וכל ההצעות לבדיקה.` };
  return { ...r, notes: [note, ...r.notes] };
}

/** Lowers the given confidences to "possible", with a warning that says why. */
function capConfidence(r: EngineResult, levels: readonly Confidence[], why: Reason): EngineResult {
  return { ...r, suggestions: r.suggestions.map((s) => (levels.includes(s.confidence) ? { ...s, confidence: "possible" as const, warnings: [...s.warnings, why] } : s)) };
}

export async function maxlinkJob(
  registry: SourceRegistry,
  steps: readonly PlanStep[],
  options: MaxLinkJobOptions,
  ctx: EngineContext,
  runners: Partial<Record<string, SingleRunner>> = SINGLE_BOOK_RUNNERS,
): Promise<MaxLinkJobResult> {
  // steps of the same pair next to each other, so the pair is read once, and pairs that share a book
  // (every commentary on one base) next to each other, so that book is read once too; else the plan's order
  const order = new Map<string, number>();
  const pairKey = (s: PlanStep) => (s.kind === "pair" ? `${s.source.key}>${s.target.key}` : `single:${s.id}`);
  const shared = (s: PlanStep) => (s.kind === "pair" ? `book:${s.target.key}` : `single:${s.id}`);
  for (const s of steps) for (const k of [shared(s), pairKey(s)]) if (!order.has(k)) order.set(k, order.size);
  const sorted = [...steps].sort((a, b) => order.get(shared(a))! - order.get(shared(b))! || order.get(pairKey(a))! - order.get(pairKey(b))!);
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
          // drop the previous pair before reading the next one — but keep a book the next pair shares
          const wanted = (x: EngineBook) => x.book.key === step.source.key || x.book.key === step.target.key;
          const kept: EngineBook[] = loaded ? [loaded.source, loaded.target].filter(wanted) : [];
          loaded = null;
          const reuse = (b: BookRef) => kept.find((x) => x.book.key === b.key);
          try {
            const source = reuse(step.source) ?? (await load(registry, step.source));
            const target = reuse(step.target) ?? (await load(registry, step.target));
            loaded = { key, source, target };
          } catch (err) {
            if (ctx.signal?.aborted) throw err;
            loadError = { key, message: messageOf(err) };
            throw err;
          }
        }
        ctx.signal?.throwIfAborted();
        result = runScoped(step, loaded.source, loaded.target, optionsOf(step.engine), inner);
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
