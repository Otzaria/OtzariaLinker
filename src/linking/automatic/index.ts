import { sefariaOwnedOf } from "../../core/links/sefaria-owned";
import { applyRunRanges, RUN_RANGE_MODES, type RunRangeBook, type RunRangeMode, type RunRangeOptions } from "../ranges";
import type { CitationsOptions } from "./citations";
import { diburHamatchilSteps, type DhOptions } from "./dibur-hamatchil";
import { runFootnotesEngine, type FootnotesOptions } from "./footnotes";
import { headingsSteps, type HeadingsOptions } from "./headings";
import { runPatternEngine, type PatternOptions } from "./pattern";
import { compileForEngine, LineGate, SOURCE_FILTER_OPTION } from "./source-filter";
import { runSliced, runToEnd, type EngineSteps } from "./steps";
import type { EngineBook, EngineContext, EngineId, EngineResult } from "./types";

/*
 * All automatic engines behind one call. Every engine links SOURCE → TARGET in the file direction:
 *   headings, dibur-hamatchil: the user gives the commentary first and the base second;
 *   footnotes:                 the main book (with markers) first, the notes book second.
 * A suggestion's own source/target is the RECORD direction, which may differ: dibur-hamatchil writes
 * base → commentary with a word anchor when both books are Otzaria's (docs/research/DH_ANCHOR_DIRECTION.md).
 */
export type EngineOptions = { headings: HeadingsOptions; footnotes: FootnotesOptions; "dibur-hamatchil": DhOptions; citations: CitationsOptions; pattern: PatternOptions };

export interface EngineInfo {
  id: EngineId;
  title: string;
  /** what the user picks as source and target, in plain words */
  sourceRole: string;
  targetRole: string;
  description: string;
  /** reads one book only; its targets are all the open books (no target to pick, no batch pairing) */
  singleBook?: boolean;
  /** a pair engine that never runs in a batch by title (it needs a pair the user chose, e.g. a pattern of their own) */
  noBatch?: boolean;
  /**
   * What the engine places a line by: "words" — the line's own text, a quote of the base (dibur-hamatchil)
   * or a reference it writes out (citations, pattern); "structure" — the books' layout, headings or note
   * numbers. The merge settles a conflict between the two kinds by it (merge.ts, AUTOMATION_ENGINE.md §5.3).
   */
  evidence: "words" | "structure";
}

export const ENGINES: readonly EngineInfo[] = [
  {
    id: "headings",
    evidence: "structure",
    title: "לפי כותרות",
    sourceRole: "הפירוש",
    targetRole: "ספר הבסיס",
    description: "כל שורה בפירוש מקושרת למקום בבסיס לפי הכותרות שמעליה: פרק ופסוק, סימן וסעיף, דף ועמוד.",
  },
  {
    id: "dibur-hamatchil",
    evidence: "words",
    title: "לפי דיבור המתחיל",
    sourceRole: "הפירוש",
    targetRole: "ספר הבסיס",
    description: 'כל דיבור המתחיל בפירוש מחופש בטקסט הבסיס, בתוך הפרק שהכותרות מצביעות עליו. כששני הספרים מאוצריא, הקישור נכתב מצד הבסיס עם עוגן על מילות הד"ה.',
  },
  {
    id: "footnotes",
    evidence: "structure",
    title: "הערות שוליים",
    sourceRole: "הספר עם סימני ההערות",
    targetRole: "ספר ההערות",
    description: "מספרי ההערות בטקסט (<sup>, סוגריים או תבנית משלכם) מותאמים לשורות בספר ההערות, גם כשהמספור מתחיל מחדש בכל פרק.",
    noBatch: true,
  },
  {
    id: "citations",
    evidence: "words",
    title: "מראי מקומות",
    sourceRole: "הספר שבו נמצאות ההפניות",
    targetRole: "כל הספרים הפתוחים",
    description: `הפניות בטקסט, כמו "(בראשית א, ב)", "ב"ק דף לג ע"ב" או "רמב"ם הל' שבת פ"א ה"ב", מקושרות לשורה שהן מציינות בספרים הפתוחים בכלי. צריך לבחור רק את ספר המקור.`,
    singleBook: true,
  },
  {
    id: "pattern",
    evidence: "words",
    title: "לפי תבנית",
    sourceRole: "הספר עם ההפניות",
    targetRole: "הספר שאליו מפנים",
    description: 'ביטוי רגולרי שלכם מוצא מספר בכל שורה (למשל "סימן יב"), והמספר קובע לאן לקשר: מספר שורה ביעד, שורה בתוך הפרק, או כותרת ממוספרת.',
    noBatch: true,
  },
];

/** Runs an engine to the end, in this thread (tests, tools; the worker uses runEngineSliced). */
export function runEngine(id: EngineId, source: EngineBook, target: EngineBook, options: Record<string, unknown> = {}, ctx: EngineContext = {}): EngineResult {
  return runToEnd(engineSteps(id, source, target, options, ctx));
}

/**
 * Runs an engine in slices, giving the thread back between them (steps.ts): in the worker, a cancel
 * then reaches `ctx.signal` while the engine runs, and other requests are answered meanwhile.
 */
export function runEngineSliced(id: EngineId, source: EngineBook, target: EngineBook, options: Record<string, unknown> = {}, ctx: EngineContext = {}): Promise<EngineResult> {
  return runSliced(engineSteps(id, source, target, options, ctx));
}

/**
 * An engine as steps. Dibur-hamatchil and headings yield before every line (they run for seconds to
 * minutes on large pairs: 35 s for שער הציון ← משנה ברורה); footnotes and pattern are single linear
 * passes over the lines (milliseconds to a second) and run as one step.
 */
export function* engineSteps(id: EngineId, source: EngineBook, target: EngineBook, options: Record<string, unknown> = {}, ctx: EngineContext = {}): EngineSteps<EngineResult> {
  // the line filter of the run (issue #27, findings #40 A1; source-filter.ts LineGate): which lines of the SOURCE may carry a link, the
  // book as this engine reads it (same indexes, same lengths, so its output refers to the original lines), and the guard on what it proposes
  // the ranges of the run (linking/ranges.ts applyRunRanges, v3 F-104): set on what the engine proposed, before the guard, so that a
  // range "until the next match" over a line the filter excludes is trimmed there (LineGate.rangeEnd)
  const { [SOURCE_FILTER_OPTION]: sourceFilter, sourceRange, targetRange, ...engineOptions } = options;
  const ranges = runRangeOptions(sourceRange, targetRange);
  // "the next match" is one the guard keeps: a suggestion it drops does not end a range (V7 round 2 review, finding 10)
  const ranged = (r: EngineResult, gate?: LineGate): EngineResult => {
    if (!ranges) return r;
    const owned = sefariaOwnedOf(options["sefariaOwned"] as readonly string[] | undefined);
    const out = applyRunRanges(r.suggestions, { source: rangeBookOf(source, owned(source.book)), target: rangeBookOf(target, owned(target.book)) }, ranges, gate && ((s) => gate.keeps(s)));
    return { ...r, suggestions: out.suggestions, notes: [...r.notes, ...out.notes] };
  };
  if (sourceFilter === undefined) return ranged(yield* runEngineSteps(id, source, target, engineOptions, ctx));
  const gate = new LineGate(source.book.key, compileForEngine(sourceFilter, id), ENGINES.find((e) => e.id === id)?.evidence !== "structure");
  const r = ranged(yield* runEngineSteps(id, gate.book(source), target, engineOptions, ctx), gate);
  const guarded = gate.guard(r);
  return { ...guarded, notes: [gate.note(), ...guarded.notes] };
}

/** The run's range options, checked (a value no form can make is an error, never ignored); null when both are the engine's. */
function runRangeOptions(sourceRange: unknown, targetRange: unknown): RunRangeOptions | null {
  const check = (v: unknown): RunRangeMode | undefined => {
    if (v === undefined) return undefined;
    if (typeof v === "string" && (RUN_RANGE_MODES as readonly string[]).includes(v)) return v as RunRangeMode;
    throw Object.assign(new Error("הגדרת הטווחים של ההרצה אינה מוכרת: בחרו \"כמו שהשיטה מציעה\", \"שורה אחת\" או \"עד ההתאמה הבאה\"."), { code: "engine/invalid-option" });
  };
  const s = check(sourceRange);
  const t = check(targetRange);
  if ((s ?? "engine") === "engine" && (t ?? "engine") === "engine") return null;
  return { ...(s && { sourceRange: s }), ...(t && { targetRange: t }) };
}

/** A book of the run as the range rule reads it: its length (the last line read) and its heading lines. */
function rangeBookOf(b: EngineBook, sefaria: boolean): RunRangeBook {
  const headings = new Set<number>();
  let last = -1;
  for (const l of b.lines) {
    if (l.heading !== null) headings.add(l.index);
    if (l.index > last) last = l.index;
  }
  return { key: b.book.key, lineCount: last + 1, headings, sefaria };
}

function* runEngineSteps(id: EngineId, source: EngineBook, target: EngineBook, options: Record<string, unknown>, ctx: EngineContext): EngineSteps<EngineResult> {
  switch (id) {
    case "headings":
      return yield* headingsSteps(source, target, options as HeadingsOptions, ctx);
    case "dibur-hamatchil":
      return yield* diburHamatchilSteps(source, target, options as DhOptions, ctx);
    case "footnotes":
      return runFootnotesEngine(source, target, options as FootnotesOptions, ctx);
    case "pattern":
      return runPatternEngine(source, target, options as PatternOptions, ctx);
    case "citations":
      // single-book: the worker runs it through citationsJob, which reads the library's indexes
      throw Object.assign(new Error('שיטת "מראי מקומות" מקשרת ספר אחד אל כל הספרים הפתוחים, ולא זוג ספרים.'), { code: "engine/single-book" });
    default:
      throw Object.assign(new Error(`המנוע "${id}" עדיין לא זמין בגרסה הזו.`), { code: "engine/unavailable" });
  }
}

export * from "./types";
export { applySourceFilter, compileForEngine, compileSourceFilter, LineGate, parseSourceFilter, previewSourceFilter, runLineFilter, SOURCE_FILTER_OPTION, type SourceFilter, type SourceFilterPreview } from "./source-filter";
export { runSliced, runToEnd, SLICE_MS, type EngineSteps } from "./steps";
export * from "./sort";
