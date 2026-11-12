import type { BookRef, LinkSide, RawAnchor } from "../../core/links/model";

/*
 * The contract every automatic linking engine fulfils (stages 8–9). An engine is a pure function
 * from loaded book lines to SUGGESTIONS; it never creates links itself. The user (or an explicit
 * "approve all certain" action) turns suggestions into links through the state layer.
 *
 * Engines are synchronous over in-memory lines and cooperative: they call `ctx.progress` now and
 * then and stop as soon as `ctx.signal.aborted` is true. They run inside the worker.
 */

/** Plain-language confidence ladder (stage 9). Default policy: only "certain" may be auto-approved. */
export type Confidence = "certain" | "high" | "possible" | "ambiguous" | "none";

export const CONFIDENCE_ORDER: readonly Confidence[] = ["certain", "high", "possible", "ambiguous", "none"];

export const CONFIDENCE_LABELS: Readonly<Record<Confidence, string>> = {
  certain: "ודאית",
  high: "גבוהה",
  possible: "אפשרית",
  ambiguous: "עמומה",
  none: "אין התאמה",
};

/** One reason for (or against) a match, written for a non-technical reader. */
export interface Reason {
  /** stable machine code, e.g. "heading/same-number", "dh/exact" */
  readonly code: string;
  /** Hebrew sentence, e.g. "שם הפרק זהה" */
  readonly text: string;
}

export interface Candidate {
  readonly target: LinkSide;
  /** 0..1 */
  readonly score: number;
  readonly reasons: readonly Reason[];
}

export interface Suggestion {
  /** deterministic for the same input (engine + source position + target), so re-runs keep decisions */
  readonly id: string;
  readonly engine: EngineId;
  readonly source: LinkSide;
  readonly anchor?: RawAnchor;
  readonly target: LinkSide;
  /**
   * The whole place the mention names, when `target` is only its first line (a cited unit in a Sefaria
   * book: the weekly sync remaps only the start, so no range is stored — B1; or ranges are off in the
   * settings). Shown to the reviewer; the real-DB measure counts a stored link anywhere in it as a match.
   */
  readonly citedSpan?: { readonly line: number; readonly end: number };
  /** canonical lower-case connection type, e.g. "commentary" */
  readonly declaredType: string;
  /** heRef_2 for the target, built from the target book's title and headings */
  readonly heRef2: string;
  /** 0..1 */
  readonly score: number;
  readonly confidence: Confidence;
  readonly reasons: readonly Reason[];
  /** ids of the rules that fired, for the advanced view and for tests */
  readonly rules: readonly string[];
  /** other targets the engine considered, best first (never includes `target`) */
  readonly alternatives: readonly Candidate[];
  readonly warnings: readonly Reason[];
}

/** "citations" is a SINGLE-BOOK engine: it reads one source and links into whatever books are open (workers/citations-job.ts). */
export type EngineId = "headings" | "footnotes" | "dibur-hamatchil" | "citations" | "pattern";

/** The minimal per-line facts an engine needs (a subset of SourceLine, so engines stay in `linking`). */
export interface EngineLine {
  /** 0-based */
  readonly index: number;
  /** the stored line (may contain HTML) */
  readonly text: string;
  /** 1–6 when the generator treats the line as a heading */
  readonly heading: number | null;
  /** the database's display reference for this line (e.g. "בראשית א, ג"), when the source has one */
  readonly heRef?: string | null;
}

export interface EngineBook {
  readonly book: BookRef;
  readonly lines: readonly EngineLine[];
}

export interface EngineContext {
  readonly signal?: AbortSignal;
  /** done/total in the engine's own units; called at most every few hundred ms of work */
  readonly progress?: (done: number, total: number) => void;
}

export interface EngineResult {
  readonly suggestions: readonly Suggestion[];
  /** things the user should know about the run as a whole (e.g. "numbering restarts were found in 3 places") */
  readonly notes: readonly Reason[];
  /** source lines the engine looked at and could not place — shown as "no match" in QA */
  readonly unmatched: readonly { readonly line: number; readonly reasons: readonly Reason[] }[];
}

/** Thresholds are user-adjustable in advanced mode; these are the conservative defaults. */
export interface ConfidenceThresholds {
  readonly certain: number;
  readonly high: number;
  readonly possible: number;
  /** a second candidate within this score of the best makes the result ambiguous */
  readonly ambiguityMargin: number;
}

export const DEFAULT_THRESHOLDS: ConfidenceThresholds = { certain: 0.95, high: 0.85, possible: 0.6, ambiguityMargin: 0.05 };

export function confidenceOf(score: number, runnerUp: number | null, t: ConfidenceThresholds = DEFAULT_THRESHOLDS): Confidence {
  if (score < t.possible) return "none";
  if (runnerUp !== null && score - runnerUp < t.ambiguityMargin) return "ambiguous";
  if (score >= t.certain) return "certain";
  if (score >= t.high) return "high";
  return "possible";
}
