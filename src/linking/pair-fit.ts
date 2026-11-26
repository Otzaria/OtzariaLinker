import type { BookRef } from "../core/links/model";
import { baseTitleKey, declaredBaseKey } from "../core/links/titles";
import { CONFIDENCE_ORDER, type Confidence, type EngineResult, type Reason, type Suggestion } from "./automatic/types";

/*
 * Pair suitability (#42 C10, V7 §2.6): is this commentary written on this base at all? The headings engine has its title check
 * (title-fit.ts); the ד"ה engine had nothing, and unrelated pairs of the official database got 5–32 "high" suggestions each —
 * a commentary quotes common words, and the walk finds them somewhere in any book.
 *
 * The verdict weighs independent kinds of evidence, each reported with its number:
 *   - metadata: the database declares the base (book_base_text), or the title says "X על <base>";
 *   - the library: links the database already has between the two books;
 *   - the words: of the commentary lines whose ד"ה was searched, how many were found directly (not inherited), and whether the
 *     places found move forward through the base as the commentary does (a commentary follows its base; matches in an
 *     unrelated book scatter);
 *   - identity: two editions of the same work are not a commentary pair (the edition tools align them, not this).
 * Headings are NOT evidence against a pair: a commentary whose headings differ from its base's is still its commentary, and the
 * ד"ה method exists for exactly that case. No verdict here is a ruling on the user: a pair the user named runs whatever this says,
 * with a warning (applyPairFit).
 */

export type PairFitVerdict = "suitable" | "undecided" | "unsuitable";

export interface PairFitMetrics {
  /** the database or the title declares the base */
  readonly declared: boolean;
  /** links the library already has between the two books (-1: not known) */
  readonly libraryLinks: number;
  /** the two titles name the same work */
  readonly sameWork: boolean;
  /** commentary lines whose ד"ה was searched: found directly + not found */
  readonly searched: number;
  /** of those, placed by their own words (not inherited from the line before) */
  readonly direct: number;
  /** direct / searched */
  readonly matchRate: number;
  /** of consecutive direct matches (by commentary line), the share that move forward or stay in the base */
  readonly forward: number;
}

export interface PairFitReport {
  readonly verdict: PairFitVerdict;
  readonly reasons: readonly (Reason & { readonly ok: boolean })[];
  readonly metrics: PairFitMetrics;
}

/**
 * Thresholds, set on the V7 matching benchmark's tuning pairs and unrelated named pairs, checked on the held-out pairs and the
 * rotated unrelated pairs (docs/validation/V7_MATCHING_BENCHMARK.md §5).
 */
export const PAIR_FIT = {
  /**
   * at least this many library links between the two books, and at least libraryShare of the searched lines: the library already says
   * they belong together. A share, because a commentary cites other books too: רש"י על בראשית has 86 links to שמות (5% of its lines)
   */
  libraryLinks: 20,
  libraryShare: 0.2,
  /** the words alone call a pair suitable from this many direct matches… */
  minDirect: 20,
  /** …at this share of the searched lines… */
  suitableRate: 0.3,
  /** …moving forward this often */
  suitableForward: 0.8,
  /** fewer searched lines than this say nothing */
  minSearched: 30,
  /** below this share of searched lines found, with no other evidence: unsuitable */
  unsuitableRate: 0.1,
  /** matches that move forward less often than this scatter: unsuitable */
  unsuitableForward: 0.6,
} as const;

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** a ד"ה line placed by its own words: its rules name the search window or a note marker (an inherited line has neither) */
const isDirect = (s: Suggestion) => s.rules.some((r) => r.startsWith("dh/window-")) && s.confidence !== "none";

export interface PairFitInput {
  readonly commentary: BookRef;
  readonly base: BookRef;
  /** the ד"ה engine's result on the pair, unmatched lines included; null when it did not run */
  readonly dh: EngineResult | null;
  /** the database's book_base_text names the base (SourceBook.bases), or the planner found the pair by it */
  readonly declared?: boolean;
  /** links the library has between the two books, when known */
  readonly libraryLinks?: number;
}

export function pairFit(input: PairFitInput): PairFitReport {
  const titleDeclares = declaredBaseKey(input.commentary.title) === baseTitleKey(input.base.title);
  const declared = input.declared === true || titleDeclares;
  const sameWork = baseTitleKey(input.commentary.title) === baseTitleKey(input.base.title);
  const libraryLinks = input.libraryLinks ?? -1;
  const direct = (input.dh?.suggestions ?? []).filter(isDirect);
  const notFound = (input.dh?.unmatched ?? []).filter((u) => u.reasons.some((r) => r.code === "dh/not-found")).length;
  const searched = new Set(direct.map((s) => lineOf(s, input.commentary.key))).size + notFound;
  const byLine = [...direct].sort((a, b) => lineOf(a, input.commentary.key) - lineOf(b, input.commentary.key));
  let steps = 0;
  let ahead = 0;
  for (let i = 1; i < byLine.length; i++) {
    const [p, q] = [baseLine(byLine[i - 1]!, input.base.key), baseLine(byLine[i]!, input.base.key)];
    if (p === null || q === null) continue;
    steps++;
    if (q >= p) ahead++;
  }
  const metrics: PairFitMetrics = {
    declared,
    libraryLinks,
    sameWork,
    searched,
    direct: new Set(direct.map((s) => lineOf(s, input.commentary.key))).size,
    matchRate: searched ? new Set(direct.map((s) => lineOf(s, input.commentary.key))).size / searched : 0,
    forward: steps ? ahead / steps : 0,
  };

  const reasons: (Reason & { ok: boolean })[] = [];
  const add = (code: string, ok: boolean, text: string) => reasons.push({ code: `pair-fit/${code}`, ok, text });
  const T = PAIR_FIT;
  if (sameWork) add("same-work", false, `"${input.commentary.title}" ו"${input.base.title}" הם שם של אותו חיבור: כנראה שתי מהדורות שלו, ולא פירוש ובסיס. כדי ליישר מהדורות השתמשו בהעברת קישורים בין מהדורות.`);
  if (declared) add("declared", true, titleDeclares ? `שם הספר "${input.commentary.title}" אומר שהוא נכתב על "${input.base.title}".` : `המסד מציין ש"${input.base.title}" הוא ספר הבסיס של "${input.commentary.title}".`);
  const libraryBacks = libraryLinks >= T.libraryLinks && (!metrics.searched || libraryLinks >= T.libraryShare * metrics.searched);
  if (libraryBacks) add("library", true, `בספרייה כבר יש ${libraryLinks.toLocaleString("he")} קישורים בין שני הספרים.`);
  else if (libraryLinks === 0) add("no-library", false, "בספרייה אין אף קישור בין שני הספרים.");
  else if (libraryLinks > 0) add("few-library", false, `בספרייה יש רק ${libraryLinks.toLocaleString("he")} קישורים בין שני הספרים (מראי מקומות, כנראה), מעט מדי ביחס לשורות הפירוש.`);
  const lexical = metrics.searched >= T.minSearched;
  if (lexical) {
    const said = `מתוך ${metrics.searched.toLocaleString("he")} שורות שהדיבור המתחיל שלהן חופש, ${metrics.direct.toLocaleString("he")} (${pct(metrics.matchRate)}) נמצאו לפי המילים שלהן, ו־${pct(metrics.forward)} מהמעברים ביניהן מתקדמים בספר הבסיס יחד עם הפירוש.`;
    const strongWords = metrics.direct >= T.minDirect && metrics.matchRate >= T.suitableRate && metrics.forward >= T.suitableForward;
    const weakWords = metrics.matchRate < T.unsuitableRate || metrics.forward < T.unsuitableForward;
    add(strongWords ? "words" : weakWords ? "words-weak" : "words-some", strongWords, strongWords ? `${said} כך נראה פירוש שנכתב על הספר הזה.` : weakWords ? `${said} פירוש על ספר מצטט אותו לרוב ובסדר שלו; כאן ההתאמות מעטות או מפוזרות, כמו מילים נפוצות שנמצאו במקרה.` : `${said} זה לא מספיק כדי לקבוע.`);
  } else if (input.dh) add("words-few", false, `רק ${metrics.searched.toLocaleString("he")} שורות עם דיבור המתחיל חופשו: מעט מדי כדי לשפוט לפי המילים.`);

  const supported = declared || libraryBacks;
  const wordsFor = reasons.some((r) => r.code === "pair-fit/words");
  const wordsAgainst = reasons.some((r) => r.code === "pair-fit/words-weak");
  const verdict: PairFitVerdict = sameWork ? "unsuitable" : supported || wordsFor ? "suitable" : wordsAgainst ? "unsuitable" : "undecided";
  return { verdict, reasons, metrics };
}

const lineOf = (s: Suggestion, commentaryKey: string) => (s.source.book.key === commentaryKey ? s.source.line : s.target.line);
const baseLine = (s: Suggestion, baseKey: string): number | null => (s.target.book.key === baseKey ? s.target.line : s.source.book.key === baseKey ? s.source.line : null);

const rank = (c: Confidence) => CONFIDENCE_ORDER.indexOf(c);

/**
 * What a run does with the verdict. `forced`: the user named the pair (or the method for it) — it always runs, and anything but
 * "suitable" caps every suggestion at "possible" with the reasons. Otherwise "unsuitable" drops the suggestions (a note says why
 * and how to force it), "undecided" caps them at "possible", "suitable" changes nothing.
 */
export function applyPairFit(result: EngineResult, report: PairFitReport, forced: boolean, titles: { commentary: string; base: string }): EngineResult {
  if (report.verdict === "suitable") return result;
  const why = report.reasons.filter((r) => !r.ok).map((r) => r.text).join(" ");
  if (report.verdict === "unsuitable" && !forced)
    return {
      suggestions: [],
      unmatched: result.unmatched,
      notes: [{ code: "pair-fit/skipped", text: `"${titles.commentary}" כנראה אינו פירוש על "${titles.base}", ולכן ההצעות בזוג הזה לא הוצגו. ${why} אם הוא כן פירוש עליו, בחרו את הזוג או את השיטה במפורש, וההצעות יוצגו לבדיקה.` }, ...result.notes],
    };
  const code = forced ? "pair-fit/forced" : "pair-fit/undecided";
  const text = forced
    ? `בחרתם להריץ את הזוג הזה, אבל ${report.verdict === "unsuitable" ? "הבדיקה מצאה שכנראה אין קשר בין הספרים" : "הבדיקה לא הכריעה אם הפירוש נכתב על הספר הזה"}. ${why} לכן כל ההצעות לבדיקה ("אפשרית" לכל היותר).`
    : `לא ידוע אם "${titles.commentary}" נכתב על "${titles.base}". ${why} לכן כל ההצעות בזוג הזה לבדיקה ("אפשרית" לכל היותר).`;
  const warning: Reason = { code, text };
  return {
    ...result,
    notes: [warning, ...result.notes],
    suggestions: result.suggestions.map((s) =>
      rank(s.confidence) < rank("possible") ? { ...s, confidence: "possible", score: Math.min(s.score, 0.84), rules: [...s.rules, code], warnings: [...s.warnings, warning] } : s,
    ),
  };
}
