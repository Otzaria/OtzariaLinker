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

/** A span of words in a line: raw offsets (UTF-16, end exclusive) in the engine's line text, as RawAnchor counts them. */
export interface MatchedSpan {
  readonly rawStart: number;
  readonly rawEnd: number;
}

/**
 * Where the matched words are, on the line of each side of the suggestion (`source` = the line of `source`, `target`
 * = the line of `target`; a side with no known words is absent). Data for a screen to highlight; never written to a
 * file, and not part of the suggestion's id or its rejection key.
 */
export interface MatchedWords {
  readonly source?: MatchedSpan;
  readonly target?: MatchedSpan;
}

export interface Suggestion {
  /** deterministic for the same input (engine + source position + target), so re-runs keep decisions */
  readonly id: string;
  readonly engine: EngineId;
  readonly source: LinkSide;
  readonly anchor?: RawAnchor;
  /** the words the engine matched on both lines (dibur-hamatchil: the ד"ה on the commentary line, the quoted words on the base line) */
  readonly matched?: MatchedWords;
  readonly target: LinkSide;
  /**
   * The whole place the mention names, when `target` is only its first line (a cited unit in a Sefaria
   * book: the weekly sync remaps only the start, so no range is stored — B1; or ranges are off in the
   * settings). Shown to the reviewer; the real-DB measure counts a stored link anywhere in it as a match.
   * Every engine that collapses a range on a Sefaria side keeps it here (core/links/sefaria-owned.ts
   * withoutRange): headings (a section), dibur-hamatchil (a quote over several lines), pattern. It is
   * never written; the merge reads it so that a precise line inside the span agrees with it (merge.ts).
   */
  readonly citedSpan?: { readonly line: number; readonly end: number };
  /**
   * The single-line records a span on a Sefaria side is written as, when more than one (withoutRange: every
   * line of `citedSpan` that can carry a ref_2, for a span of at most SPAN_EACH_LINE_MAX lines); the first
   * is `target`, with `heRef2`. The reviewer sees ONE suggestion; approving makes one link per record, and
   * rejecting removes them all (state/suggestions.ts). Absent: the suggestion is written as `target` alone.
   */
  readonly spanLines?: readonly { readonly line: number; readonly heRef2: string }[];
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

/**
 * A link that stands for a whole span but is written as single lines (a range collapsed on a Sefaria side:
 * `citedSpan`, core/links/sefaria-owned.ts withoutRange) is not the exact place, so it is never "certain" —
 * only "certain" is approved in bulk. Measured on 16 commentaries (LIBRARY_BENCHMARK.md §0.6): such links
 * left "certain" agreed with the library's own line in 82.3% of the judged ones, the rest in 99.8%.
 * The citations engine keeps its own rule for a cited unit (it names the unit, not a line in it).
 */
export function capSpanned(confidence: Confidence, citedSpan: { readonly line: number; readonly end: number } | undefined): { confidence: Confidence; warning?: Reason } {
  if (!citedSpan || confidence !== "certain") return { confidence };
  return {
    confidence: "high",
    warning: { code: "range/sefaria-not-exact", text: `הקישור עומד לשורות ${citedSpan.line + 1}–${citedSpan.end + 1}, אבל בספר ספריא אין טווח, והוא נכתב כשורות בודדות. זה אינו המקום המדויק, ולכן הוא לבדיקה ולא לאישור בקבוצה.` },
  };
}

/** The single-line records a suggestion is written as: its `spanLines`, else its target alone. */
export function recordsOf(s: Suggestion): readonly { readonly line: number; readonly heRef2: string }[] {
  return s.spanLines?.length ? s.spanLines : [{ line: s.target.line, heRef2: s.heRef2 }];
}

export function confidenceOf(score: number, runnerUp: number | null, t: ConfidenceThresholds = DEFAULT_THRESHOLDS): Confidence {
  if (score < t.possible) return "none";
  if (runnerUp !== null && score - runnerUp < t.ambiguityMargin) return "ambiguous";
  if (score >= t.certain) return "certain";
  if (score >= t.high) return "high";
  return "possible";
}
