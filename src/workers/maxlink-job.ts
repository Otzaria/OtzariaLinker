import { scanEnd } from "../core/limits";
import { parseConnectionType, SOURCE_VIEW_TYPES } from "../core/links/connection-type";
import { linesFingerprint } from "../core/text/fingerprint";
import type { BookRef, LinkSide } from "../core/links/model";
import { refBlockOf, sefariaOwnedOf, withoutRange } from "../core/links/sefaria-owned";
import { capSpanned, compileForEngine, LineGate, runEngineSliced, SOURCE_FILTER_OPTION, type Confidence, type EngineBook, type EngineContext, type EngineResult, type Reason, type Suggestion } from "../linking/automatic";
import { capConfidence, capUndecided } from "../linking/batch";
import { titleFit, titleGateAdvice, type TitleFitReport, type TitleGateAdvice } from "../linking/title-fit";
import { MAXLINK_PROGRESS_UNIT, type MaxLinkJobResult, type StepResult } from "../linking/maxlink-report";
import { linePairKey } from "../linking/merge";
import type { PlanStep, SingleEngineId } from "../linking/plan";
import { partSection, partsOf, sectionFor, type Section } from "../linking/sections";
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
  /** keys of the books the library treats as Sefaria's (core/links/sefaria-owned.ts), given to every engine */
  sefariaOwned?: readonly string[];
  /**
   * The line filter of the run (issue #27, findings #40 A1; linking/automatic/source-filter.ts): given to every engine of every step, and
   * checked again on what each step returns, whichever path produced it.
   */
  sourceFilter?: unknown;
  /**
   * A time budget for each step: a step that runs longer is stopped with what it found (marked `stopped`)
   * and the job goes on to the next one — unlike a cancel, which stops the job. The app does not set it;
   * the library benchmark does (BENCH_STEP_S), so one slow pair does not cost the book's other steps.
   */
  stepBudgetMs?: number;
}

/**
 * The step's signal under a budget: aborted when the job is cancelled or the time is up. The engines poll
 * `aborted` between slices; the job's own cancel still reaches listeners through the outer signal.
 */
function budgetSignal(outer: AbortSignal | undefined, until: number): AbortSignal {
  const aborted = () => outer?.aborted === true || Date.now() > until;
  return {
    get aborted() {
      return aborted();
    },
    get reason() {
      return outer?.aborted ? outer.reason : aborted() ? new DOMException("step time budget", "TimeoutError") : undefined;
    },
    throwIfAborted() {
      if (aborted()) throw outer?.aborted ? outer.reason : new DOMException("step time budget", "TimeoutError");
    },
    addEventListener: (...a: Parameters<AbortSignal["addEventListener"]>) => outer?.addEventListener(...a),
    removeEventListener: (...a: Parameters<AbortSignal["removeEventListener"]>) => outer?.removeEventListener(...a),
    dispatchEvent: () => false,
    onabort: null,
  } as unknown as AbortSignal;
}

/** units of progress per step: engines report their own progress inside a step */
const UNIT = MAXLINK_PROGRESS_UNIT;

/**
 * A pair step. When the dependant is written on several bases (Relation.scope), only the part of it
 * headed by this base is read (linking/sections.ts); headings' "high" there is left for review (a
 * range to a whole chapter of a section was right in 6 of 313 on the real database). Without such a
 * part only dibur-hamatchil runs, on the whole book, and nothing it finds is above "possible": its
 * windows come from headings that may follow another base's numbering. Measurements:
 * docs/AUTOMATION_ENGINE.md §5.1, tests/validation/multibase.test.ts.
 */
async function runScoped(step: Extract<PlanStep, { kind: "pair" }>, source: EngineBook, target: EngineBook, options: Record<string, unknown>, ctx: EngineContext, byLinks?: Section | null): Promise<EngineResult> {
  const scope = step.relation.scope;
  if (!scope) return runEngineSliced(step.engine, source, target, options, ctx);
  if (scope.baseSection !== undefined) return runPartToPart(step, source, target, scope.section, scope.baseSection, options, ctx);
  const section = sectionFor(source, scope.section) ?? byLinks ?? null;
  if (section) {
    let r = await runEngineSliced(step.engine, section.book, target, options, ctx);
    if (step.engine === "headings") r = capConfidence(r, ["high"], { code: "maxlink/section-high", text: "קישור לפרק שלם בתוך חלק של ספר על כמה ספרים: לבדיקה." });
    const note: Reason = byLinks === section
      ? { code: "maxlink/section-by-links", text: `בספר "${source.book.title}" אין חלק בשם "${target.book.title}". החלק "${section.heading}" (${section.lines.toLocaleString("he")} שורות) הוא זה שהמסד מקשר אל "${target.book.title}", ורק הוא קושר.` }
      : { code: "maxlink/section", text: `רק החלק "${section.heading}" של "${source.book.title}" (${section.lines.toLocaleString("he")} שורות) קושר אל "${target.book.title}".` };
    return { ...r, notes: [note, ...r.notes] };
  }
  if (step.engine !== "dibur-hamatchil")
    return { suggestions: [], notes: [{ code: "maxlink/no-section", text: `בספר "${source.book.title}" אין חלק בשם "${target.book.title}", ולכן שיטה זו לא רצה עליו.` }], unmatched: [] };
  const r = capConfidence(await runEngineSliced(step.engine, source, target, options, ctx), ["certain", "high"], { code: "maxlink/dh-only", text: `בספר אין חלק בשם "${target.book.title}": המילים נמצאו בטקסט, אבל המקום לא מאומת בכותרות. לבדיקה.` });
  const note: Reason = { code: "maxlink/dh-only", text: `בספר "${source.book.title}" אין חלק בשם "${target.book.title}", ולכן רק דיבור המתחיל קישר אליו, וכל ההצעות לבדיקה.` };
  return { ...r, notes: [note, ...r.notes] };
}

/**
 * A part of the dependant against the part of the base headed by the same name (plan.ts
 * RelationScope.baseSection: "יריעות שלמה על התורה" ← "מזרחי", both divided by the five books). Both
 * parts must be found by their headings: the library's links cannot tell which part of the base a part
 * is on, and the whole base would link "שמות א" into "בראשית א". Headings' "high" is left for review,
 * as in any part (runScoped).
 */
async function runPartToPart(step: Extract<PlanStep, { kind: "pair" }>, source: EngineBook, target: EngineBook, part: string, basePart: string, options: Record<string, unknown>, ctx: EngineContext): Promise<EngineResult> {
  const mine = sectionFor(source, part);
  const theirs = sectionFor(target, basePart);
  if (!mine || !theirs) {
    const missing = !mine ? `בספר "${source.book.title}" אין חלק בשם "${part}"` : `בספר "${target.book.title}" אין חלק בשם "${basePart}"`;
    return { suggestions: [], notes: [{ code: "maxlink/no-section", text: `${missing}, ולכן שיטה זו לא רצה על החלק הזה.` }], unmatched: [] };
  }
  let r = await runEngineSliced(step.engine, mine.book, theirs.book, options, ctx);
  if (step.engine === "headings") r = capConfidence(r, ["high"], { code: "maxlink/section-high", text: "קישור לפרק שלם בתוך חלק של ספר על כמה ספרים: לבדיקה." });
  const note: Reason = { code: "maxlink/section", text: `רק החלק "${mine.heading}" של "${source.book.title}" (${mine.lines.toLocaleString("he")} שורות) קושר, ורק אל החלק "${theirs.heading}" של "${target.book.title}" (${theirs.lines.toLocaleString("he")} שורות).` };
  return { ...r, notes: [note, ...r.notes] };
}

/**
 * A notes book whose main book carries no note marks (Sefaria's notes on מכילתא דרשב"י, on מדרש אגדה, on
 * מדרש לקח טוב: no marker, no number on the note lines) gives the footnotes engine nothing to match.
 * Such notes follow the main book's headings ("פרק ג › פסוק א" over the notes of that verse), so when the
 * footnotes engine found nothing, the headings engine links them as a commentary (notes → main book).
 * Measured: docs/AUTOMATION_ENGINE.md §5.1.
 */
async function notesAsCommentary(r: EngineResult, main: EngineBook, notes: EngineBook, ctx: EngineContext, sefariaOwned?: readonly string[]): Promise<EngineResult> {
  // the library's answer to "is this a Sefaria book" goes along: no range on a Sefaria main book (audit F1)
  const h = await runEngineSliced("headings", notes, main, sefariaOwned ? { sefariaOwned } : {}, ctx);
  const note: Reason = { code: "maxlink/notes-by-headings", text: `שיטת הערות השוליים לא מצאה סימני הערה שמתאימים לשורות "${notes.book.title}", ולכן ההערות קושרו לפי הכותרות של שני הספרים, כמו פירוש.` };
  return { suggestions: h.suggestions, notes: [note, ...r.notes, ...h.notes], unmatched: h.unmatched };
}

/*
 * A book on several bases whose parts are not named after them: "פרי מגדים" is declared on the מגן אברהם,
 * the ט"ז and the שולחן ערוך, and its parts are "אשל אברהם" (on the מגן אברהם) and "משבצות זהב" (on the
 * ט"ז); in יורה דעה "שפתי דעת" is on the ש"ך. With no part named after the base only dibur-hamatchil ran,
 * on the whole book, all of it for review. The library's own links tell which part is on which base:
 * the part holding at least PART_MIN of the links to the base and PART_SHARE of them is its section.
 */
const PART_MIN = 100;
const PART_SHARE = 0.8;

export async function partByLinks(registry: SourceRegistry, source: EngineBook, targetKey: string, cache: Map<string, Map<string, number[]>>): Promise<Section | null> {
  const parts = partsOf(source);
  if (parts.length < 2) return null;
  let byOther = cache.get(source.book.key);
  if (!byOther) {
    byOther = new Map<string, number[]>();
    // a source without links answers []; a throw fails the step (its message is in the report), never
    // a silent "no part": the whole book would then be linked by dibur-hamatchil alone (review C13, M7)
    for (const l of await registry.existingLinks(source.book.key, 0, Number.MAX_SAFE_INTEGER)) {
      const [mine, other] = l.source.book.key === source.book.key ? [l.source, l.target] : [l.target, l.source];
      const list = byOther.get(other.book.key) ?? [];
      list.push(mine.line);
      byOther.set(other.book.key, list);
    }
    cache.set(source.book.key, byOther);
  }
  const lines = byOther.get(targetKey);
  if (!lines || lines.length < PART_MIN) return null;
  const posOf = new Map(source.lines.map((l, i) => [l.index, i] as const));
  const counts = parts.map(() => 0);
  for (const line of lines) {
    const pos = posOf.get(line);
    if (pos === undefined) continue;
    const k = parts.findIndex((p) => pos >= p.from && pos <= p.to);
    if (k >= 0) counts[k]!++;
  }
  const best = counts.indexOf(Math.max(...counts));
  return counts[best]! >= PART_MIN && counts[best]! >= PART_SHARE * lines.length ? partSection(source, parts[best]!) : null;
}

/**
 * The title gate (issue #21), as an advisor (fix round before the merge of PR 2). The check (linking/title-fit.ts) cannot rule on every pair:
 * it is read through titleGateAdvice. Only a ruling the measurement supports (no titles, or none of them the base's) skips the step — its
 * guards only lower confidence AFTER a run, and a wrong method yields many wrong links — with the reasons, and the user can run the
 * method on that pair by naming it (PlanChoices.methods). A doubt (partial, undecided) runs the step with a note that says why; a step the
 * user forced against the check's advice runs with a warning and nothing of it "certain". A check that cannot be made never blocks the step.
 */
function titleFitOrNull(source: EngineBook, target: EngineBook): TitleFitReport | null {
  try {
    return titleFit(source, target);
  } catch {
    return null;
  }
}

function titleGateSkip(source: EngineBook, target: EngineBook, advice: TitleGateAdvice): EngineResult {
  return {
    suggestions: [],
    notes: [{ code: "title-fit/skipped", text: `שיטת הכותרות לא הורצה על "${source.book.title}" מול "${target.book.title}": ${advice.why} שיטת דיבור המתחיל לא תלויה בכותרות. אפשר להריץ את שיטת הכותרות על הזוג הזה בבחירה מפורשת.` }],
    unmatched: [],
  };
}

/** A step that runs although the title check doubts it: the note says why; forced by the user, the suggestions also carry a warning and none is "certain". */
function titleAdvice(r: EngineResult, fit: TitleFitReport, advice: TitleGateAdvice, forced: boolean, source: string, target: string): EngineResult {
  if (forced) {
    const why: Reason = { code: "title-fit/forced", text: `בחרתם להריץ את שיטת הכותרות על "${source}" מול "${target}", ובדיקת ההתאמה לא אישרה אותה (${fit.verdict}): ${advice.why} ההצעות נשארות, אבל אינן "ודאיות" לאישור בקבוצה: בדקו אותן.` };
    const capped = { ...r, suggestions: r.suggestions.map((x) => ({ ...x, ...(x.confidence === "certain" && { confidence: "high" as const }), warnings: [...x.warnings, why] })) };
    return { ...capped, notes: [{ code: "title-fit/forced", text: why.text }, ...r.notes] };
  }
  const code = fit.verdict === "undecided" ? "title-fit/undecided" : fit.verdict === "partial" ? "title-fit/partial" : "title-fit/doubtful";
  return { ...r, notes: [{ code, text: `שיטת הכותרות רצה על "${source}" מול "${target}", אבל בדיקת ההתאמה מהססת (${fit.verdict}): ${advice.why} בדקו את ההצעות לפני אישור.` }, ...r.notes] };
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
  // a step that reaches its base through an intermediate commentary runs after every other step: it
  // reuses the intermediate pair's result of this job (runThrough)
  const late = (s: PlanStep) => (s.kind === "pair" && s.relation.through ? 1 : 0);
  const sorted = [...steps].sort((a, b) => late(a) - late(b) || order.get(shared(a))! - order.get(shared(b))! || order.get(pairKey(a))! - order.get(pairKey(b))!);
  /** each pair step's result, by engine and pair, for runThrough */
  const results = new Map<string, EngineResult>();
  /** per dependant, its existing links by other book (partByLinks reads them once) */
  const partLinks = new Map<string, Map<string, number[]>>();
  const focusBooks = [...new Set(steps.map((s) => s.source.key))];
  const total = (steps.length + focusBooks.length) * UNIT;
  const filter = options.sourceFilter;
  // an invalid filter fails the job before anything runs: running without it would link the lines the user excluded
  if (filter !== undefined) compileForEngine(filter, "headings");
  const optionsOf = (engine: string): Record<string, unknown> => ({ ...(options.engineOptions?.[engine] ?? {}), ...(options.sefariaOwned && { sefariaOwned: options.sefariaOwned }), ...(filter !== undefined && { [SOURCE_FILTER_OPTION]: filter }) });
  /** the run's filter judged on each source book once (stage 5 of source-filter.ts: the guard on every step's result) */
  const gates = new Map<string, LineGate>();
  const guard = async (step: PlanStep, r: EngineResult, source?: EngineBook): Promise<EngineResult> => {
    if (filter === undefined) return r;
    let gate = gates.get(step.source.key);
    if (!gate) {
      gate = new LineGate(step.source.key, compileForEngine(filter, step.engine));
      gate.book(source && source.book.key === step.source.key ? source : await load(registry, step.source, fps));
      gates.set(step.source.key, gate);
    }
    return gate.guard(r);
  };
  const items: StepResult[] = [];
  /** the fingerprint of every book read (MaxLinkJobResult.fingerprints) */
  const fps = new Map<string, string>();

  let loaded = null as { key: string; source: EngineBook; target: EngineBook } | null;
  let loadError = null as { key: string; message: string } | null;
  /**
   * Cancelled: the job stops and returns what it found — the steps that ran, the one that was running with
   * what its engine found until then (engines stop with an "engine/aborted" note) marked `stopped` — never
   * throws it away (the batch job keeps it as a partial book).
   */
  let stopped = false;
  for (const [i, step] of sorted.entries()) {
    if (ctx.signal?.aborted) {
      stopped = true;
      break;
    }
    ctx.progress?.(i * UNIT, total);
    const t0 = Date.now();
    const budget = options.stepBudgetMs !== undefined ? budgetSignal(ctx.signal, t0 + options.stepBudgetMs) : ctx.signal;
    const inner: EngineContext = {
      ...(budget && { signal: budget }),
      progress: (d, n) => ctx.progress?.(i * UNIT + (n > 0 ? Math.min(UNIT - 1, Math.floor((d / n) * UNIT)) : 0), total),
    };
    /** the step ran out of its own time (not the job's cancel): keep what it found and go on */
    const overBudget = () => options.stepBudgetMs !== undefined && !ctx.signal?.aborted && Date.now() > t0 + options.stepBudgetMs;
    try {
      let result: EngineResult;
      if (step.kind === "pair" && step.relation.through) {
        loaded = null;
        const user = Object.fromEntries(Object.entries(optionsOf(step.engine)).filter(([, v]) => v !== undefined && v !== ""));
        result = await guard(step, await runThrough(registry, step, results, { ...step.options, ...user }, inner, partLinks, fps));
      } else if (step.kind === "pair") {
        const key = pairKey(step);
        if (loadError?.key === key) throw new Error(loadError.message);
        if (loaded?.key !== key) {
          // drop the previous pair before reading the next one — but keep a book the next pair shares
          const wanted = (x: EngineBook) => x.book.key === step.source.key || x.book.key === step.target.key;
          const kept: EngineBook[] = loaded ? [loaded.source, loaded.target].filter(wanted) : [];
          loaded = null;
          const reuse = (b: BookRef) => kept.find((x) => x.book.key === b.key);
          try {
            const source = reuse(step.source) ?? (await load(registry, step.source, fps));
            const target = reuse(step.target) ?? (await load(registry, step.target, fps));
            loaded = { key, source, target };
          } catch (err) {
            if (ctx.signal?.aborted) throw err;
            loadError = { key, message: messageOf(err) };
            throw err;
          }
        }
        ctx.signal?.throwIfAborted();
        // the plan's options for this pair (a translation: declaredType "targum", B8) under the user's own
        const user = Object.fromEntries(Object.entries(optionsOf(step.engine)).filter(([, v]) => v !== undefined && v !== ""));
        const byLinks = step.relation.scope && step.relation.scope.baseSection === undefined && !sectionFor(loaded.source, step.relation.scope.section) ? await partByLinks(registry, loaded.source, step.target.key, partLinks) : null;
        const fit = (step.titleGate || step.titleForced) && !step.relation.scope && !step.relation.through ? titleFitOrNull(loaded.source, loaded.target) : null;
        const advice = fit ? titleGateAdvice(fit) : null;
        const skipped = fit && advice && step.titleGate && !step.titleForced && advice.action === "skip" ? titleGateSkip(loaded.source, loaded.target, advice) : null;
        result = skipped ?? (await runScoped(step, loaded.source, loaded.target, { ...step.options, ...user }, inner, byLinks));
        if (!skipped && fit && advice && advice.action !== "run") result = titleAdvice(result, fit, advice, step.titleForced === true, loaded.source.book.title, loaded.target.book.title);
        // a base chosen between editions by a rule (PlanStep.ambiguousBase): the one rule of every path (linking/batch.ts capUndecided)
        if (step.ambiguousBase) result = capUndecided(result, step.target.title, "maxlink/ambiguous-base");
        // the primary target of a hierarchy whose fallback is "review" (PlanChoices.targets, #45): nothing of it above "possible"
        if (step.targetRole === "primary-review")
          result = capConfidence(result, ["certain", "high"], { code: "maxlink/target-fallback", text: `השורה אינה מזכירה אף יעד בשמה, ולכן היא מקושרת ליעד הראשי "${step.target.title}" לבדיקה בלבד, לפי מדיניות היעדים שנבחרה.` });
        if (step.engine === "footnotes" && !result.suggestions.length) result = await notesAsCommentary(result, loaded.source, loaded.target, inner, options.sefariaOwned);
        result = await guard(step, result, loaded.source);
        // a part-to-part step is one part of the pair: runThrough reads whole pairs only
        if (step.relation.scope?.baseSection === undefined) results.set(`${step.engine}|${key}`, result);
      } else {
        loaded = null;
        const run = runners[step.engine];
        if (!run) throw new Error(`השיטה "${step.engine}" אינה זמינה בגרסה הזו.`);
        result = await guard(step, await run(registry, step.source, optionsOf(step.engine), inner));
      }
      const cut = ctx.signal?.aborted === true;
      items.push({ stepId: step.id, result: { ...result, unmatched: [] }, unmatched: result.unmatched.length, ms: Date.now() - t0, ...((cut || overBudget()) && { stopped: true }) });
      if (cut) {
        stopped = true;
        break;
      }
    } catch (err) {
      if (ctx.signal?.aborted) {
        stopped = true;
        break;
      }
      items.push({ stepId: step.id, unmatched: 0, error: messageOf(err), ms: Date.now() - t0, ...(overBudget() && { stopped: true }) });
    }
  }
  loaded = null;

  // the links the library already has, for every book a step read from (both directions: atLines).
  // A source without links answers [] (text files, databases without link tables): a throw is a real
  // failure, and the run must say so — its suggestions may already be in the library (review C13, M7)
  const keys = new Set<string>();
  const unread: { key: string; why: string }[] = [];
  // read also after a cancel (from the links table's book indexes: quick), so what was found is judged "already exists" too
  for (const [j, key] of focusBooks.entries()) {
    ctx.progress?.((steps.length + j) * UNIT, total);
    try {
      for (const l of await registry.existingLinks(key, 0, Number.MAX_SAFE_INTEGER)) keys.add(linePairKey(l));
    } catch (err) {
      unread.push({ key, why: messageOf(err) });
    }
  }
  if (ctx.signal?.aborted) stopped = true;
  // the fingerprint of every book the steps depend on (V5 P1-8): the ones a single-book engine read by
  // itself are hashed here (a text book is in its source's cache; a failing read leaves it out)
  const wanted = new Set<string>(focusBooks);
  for (const s of steps) if (s.kind === "pair") wanted.add(s.target.key);
  // a stopped book runs again from its start, and gets its fingerprints then
  const missing = stopped ? [] : [...wanted].filter((k) => !fps.has(k));
  if (missing.length) Object.entries(await fingerprintsJob(registry, missing, { ...(ctx.signal && { signal: ctx.signal }) })).forEach(([k, v]) => fps.set(k, v));
  ctx.progress?.(total, total);
  // back in the plan's order
  const pos = new Map(steps.map((s, i) => [s.id, i]));
  items.sort((a, b) => pos.get(a.stepId)! - pos.get(b.stepId)!);
  return { items, dbLinkKeys: [...keys], ...(unread.length && { dbLinksUnread: unread }), ...(stopped && { stopped: true }), fingerprints: Object.fromEntries([...fps].filter(([k]) => wanted.has(k))) };
}

/**
 * A commentary on a commentary, linked to the base of its base (plan.ts RelationThrough): the engine's
 * suggestions against each intermediate (this job's own result for that pair when it ran, else run
 * here), each carried to the base by the links the source already has between the intermediate and the
 * base. A place in the intermediate with no such link gives nothing; one whose links spread over more
 * than THROUGH_SPAN lines of the base is too vague to carry, and is counted in the notes.
 */
async function runThrough(registry: SourceRegistry, step: Extract<PlanStep, { kind: "pair" }>, results: ReadonlyMap<string, EngineResult>, options: Record<string, unknown>, ctx: EngineContext, partLinks: Map<string, Map<string, number[]>>, fps: Map<string, string>): Promise<EngineResult> {
  const out = new Map<string, Suggestion>();
  const notes: Reason[] = [];
  // the base may be a Sefaria book: no range on its side — the one rule every engine follows (sefaria-owned.ts withoutRange)
  const owned = sefariaOwnedOf(options.sefariaOwned as readonly string[] | undefined)(step.target);
  const targetLines = owned ? (await load(registry, step.target, fps)).lines : null;
  const block = targetLines ? refBlockOf(targetLines) : undefined;
  for (const via of step.relation.through ?? []) {
    let r = results.get(`${step.engine}|${step.source.key}>${via.book.key}`);
    if (!r) {
      const inner: Extract<PlanStep, { kind: "pair" }> = { ...step, target: via.book, relation: { ...step.relation, base: via.book, through: undefined, ...(via.scope ? { scope: via.scope } : { scope: undefined }) } };
      const source = await load(registry, step.source, fps);
      // the part of the dependant on this intermediate, by the library's links when no part is named after it
      const byLinks = via.scope && !sectionFor(source, via.scope.section) ? await partByLinks(registry, source, via.book.key, partLinks) : null;
      r = await runScoped(inner, source, await load(registry, via.book, fps), options, ctx, byLinks);
    }
    const toBase = await linkedLines(registry, via.book.key, step.target.key);
    let carried = 0;
    let unlinked = 0;
    let spread = 0;
    for (const sg of r.suggestions) {
      const [mine, mid] = sg.source.book.key === step.source.key ? [sg.source, sg.target] : [sg.target, sg.source];
      if (mid.book.key !== via.book.key) continue;
      // only the first and the last base line count: the base side's ranges are never expanded line by line (a
      // range end from a database nobody vouches for — 20,000,000 — cost 400+ MB here, Issue #41 C1)
      let from = Infinity;
      let to = -Infinity;
      for (let m = mid.line; m <= scanEnd(mid.line, mid.end ?? mid.line); m++)
        for (const [a, b] of toBase.get(m) ?? []) {
          if (!(b >= a)) continue; // an end before its start (or not a number) is no line at all
          from = Math.min(from, a);
          to = Math.max(to, scanEnd(a, b));
        }
      if (from > to) {
        unlinked++;
        continue;
      }
      if (to - from > THROUGH_SPAN) {
        spread++;
        continue;
      }
      const id = `${sg.engine}:through:${step.source.key}#${mine.line}>${step.target.key}#${from}`;
      if (out.has(id)) continue;
      carried++;
      const whole: LinkSide = { book: step.target, line: from, ...(to > from && { end: to }) };
      const { target, citedSpan, lines: each, reason: firstRef } = owned ? withoutRange(whole, block) : { target: whole, citedSpan: undefined, lines: undefined, reason: undefined };
      const capped = capSpanned(sg.confidence, citedSpan);
      const heRefAt = (l: number): string => targetLines?.[l]?.index === l ? (targetLines[l]!.heRef ?? "") : (targetLines?.find((x) => x.index === l)?.heRef ?? "");
      out.set(id, {
        id,
        engine: sg.engine,
        source: { book: step.source, line: mine.line, ...(mine.end !== undefined && mine.end !== mine.line && { end: mine.end }) },
        target,
        ...(citedSpan && { citedSpan }),
        ...(each && { spanLines: each.map((l) => ({ line: l, heRef2: heRefAt(l) })) }),
        declaredType: "source",
        heRef2: owned ? heRefAt(target.line) : "",
        score: sg.score,
        confidence: capped.confidence,
        reasons: [
          { code: "maxlink/through", text: `השורה מפרשת את שורה ${mid.line + 1} ב־"${via.book.title}", והמסד מקשר את השורה ההיא ל־"${step.target.title}" כאן.` },
          ...sg.reasons,
          ...(firstRef ? [firstRef] : []),
        ],
        rules: [...sg.rules, "maxlink/through"],
        alternatives: [],
        warnings: capped.warning ? [...sg.warnings, capped.warning] : sg.warnings,
      });
    }
    notes.push({
      code: "maxlink/through",
      text: `"${step.source.title}" קושר אל "${step.target.title}" דרך "${via.book.title}": ${carried.toLocaleString("he")} שורות.${unlinked ? ` ${unlinked.toLocaleString("he")} מקומות ב־"${via.book.title}" אינם מקושרים במסד אל "${step.target.title}", ולכן לא הועברו.` : ""}${spread ? ` ${spread.toLocaleString("he")} מקומות מקושרים לטווח רחב מדי, ולא הועברו.` : ""}`,
    });
  }
  return { suggestions: [...out.values()], notes, unmatched: [] };
}

/** at most this many base lines between the first and the last a place in the intermediate is linked to */
const THROUGH_SPAN = 3;

/**
 * Line of book `a` → the [from, to] line ranges of book `b` the source's existing links join it to: the
 * structural ones (COMMENTARY, TARGUM… — SOURCE_VIEW_TYPES), when there are any. A citation inside the
 * intermediate is not where its line stands on the base: the מגן אברהם's REFERENCE/LINKER links to other
 * סימנים of the שולחן ערוך spread 1,479 of its lines over more than THROUGH_SPAN lines, and 5,057 lines of
 * מחצית השקל that the composition places exactly were not carried.
 */
async function linkedLines(registry: SourceRegistry, a: string, b: string): Promise<Map<number, [number, number][]>> {
  const structural = new Map<number, [number, number][]>();
  const any = new Map<number, [number, number][]>();
  const add = (out: Map<number, [number, number][]>, aSide: { line: number; end?: number }, bSide: { line: number; end?: number }) => {
    for (let x = aSide.line; x <= scanEnd(aSide.line, aSide.end ?? aSide.line); x++) {
      const list = out.get(x) ?? [];
      list.push([bSide.line, scanEnd(bSide.line, bSide.end ?? bSide.line)]); // clipped like the own side (Issue #41 C1)
      out.set(x, list);
    }
  };
  // a source without links answers []; a throw fails the step (the report shows it) instead of carrying nothing in silence (review C13, M7)
  for (const l of await registry.existingLinks(a, 0, Number.MAX_SAFE_INTEGER)) {
    const sides = l.source.book.key === a && l.target.book.key === b ? ([l.source, l.target] as const) : l.target.book.key === a && l.source.book.key === b ? ([l.target, l.source] as const) : null;
    if (!sides) continue;
    add(any, sides[0], sides[1]);
    if (SOURCE_VIEW_TYPES.has(parseConnectionType(l.declaredType).type)) add(structural, sides[0], sides[1]);
  }
  return structural.size ? structural : any;
}

/*
 * The books the last calls read, per registry (the batch job calls runMaxLink once per book, V5 P1-8:
 * 200 commentaries on one base would read the base 200 times). Bounded in books and lines; a key names
 * one open book of one source and is never reused for another (sourceIdPrefix), so an entry cannot go stale.
 */
const CACHE_BOOKS = 4;
const CACHE_LINES = 120_000;
const bookCache = new WeakMap<SourceRegistry, Map<string, { book: EngineBook; fingerprint: string }>>();

async function loadEntry(registry: SourceRegistry, book: BookRef): Promise<{ book: EngineBook; fingerprint: string }> {
  let cache = bookCache.get(registry);
  if (!cache) bookCache.set(registry, (cache = new Map()));
  const hit = cache.get(book.key);
  if (hit) {
    cache.delete(book.key);
    cache.set(book.key, hit);
    return { book: { ...hit.book, book }, fingerprint: hit.fingerprint };
  }
  // anchorText: the line as the generator counts anchor offsets (schema 7: with footnote bodies)
  const lines = (await registry.lines(book.key, 0, Number.MAX_SAFE_INTEGER)).map((l) => ({ index: l.index, text: l.anchorText, heading: l.heading, heRef: l.heRef }));
  const entry = { book: { book, lines }, fingerprint: linesFingerprint(lines.map((l) => l.text)) };
  cache.set(book.key, entry);
  let total = 0;
  for (const e of cache.values()) total += e.book.lines.length;
  for (const [k, e] of cache) {
    if (cache.size <= 1 || (cache.size <= CACHE_BOOKS && total <= CACHE_LINES)) break;
    cache.delete(k);
    total -= e.book.lines.length;
  }
  return entry;
}

/** A book as the engines read it; `fps` collects the fingerprint of every book a job read. */
async function load(registry: SourceRegistry, book: BookRef, fps?: Map<string, string>): Promise<EngineBook> {
  const e = await loadEntry(registry, book);
  fps?.set(book.key, e.fingerprint);
  return e.book;
}

/**
 * The fingerprints of books (core/text/fingerprint.ts over their anchor text): the batch job compares
 * them with the last run's to skip the books that did not change (V5 P1-8). A book that cannot be read
 * is left out: it is run again, and its error is reported there.
 */
export async function fingerprintsJob(registry: SourceRegistry, keys: readonly string[], ctx: EngineContext): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [i, key] of keys.entries()) {
    ctx.signal?.throwIfAborted();
    ctx.progress?.(i, keys.length);
    const cached = bookCache.get(registry)?.get(key);
    if (cached) {
      out[key] = cached.fingerprint;
      continue;
    }
    try {
      out[key] = linesFingerprint((await registry.lines(key, 0, Number.MAX_SAFE_INTEGER)).map((l) => l.anchorText));
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
    }
  }
  ctx.progress?.(keys.length, keys.length);
  return out;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
