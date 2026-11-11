/*
 * Hebrew text normalization for COMPARISON (titles, headings, search) — never for anything that
 * is written back to a file. Adapted from otzaria-link-generator `src/utils/fuzzyUtils.ts`
 * (ideas and thresholds; reimplemented and reduced). See docs/research/REUSE_MATRIX.md.
 *
 * Every entry point coerces with String(): these functions are called on DB values that may be
 * null or numbers, and must never throw.
 */
import { boundedMemo } from "./memo";

/** U+0591–U+05C7: cantillation, vowel points, dagesh, meteg. */
const NIKUD_RE = /[֑-ׇ]/g;
const QUOTES_RE = /["'׳״‘’“”`]/g;
/*
 * ONE prefix letter only. The source regex is greedy (`^[ובלמשכה]+`), so "לבית" peels two letters,
 * leaves "ית" (length 2), the guard cancels the peel and the word is not shortened at all.
 */
const PREFIX_RE = /^[ובלמשכה]/;

/**
 * Structural abbreviations that occur in headings. Deliberately small and unambiguous — a full
 * acronym dictionary (hundreds of entries with several expansions each) belongs to sentence-level
 * matching, not to heading comparison.
 */
const ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\s)סי[׳']/g, "$1סימן"],
  [/(^|\s)סע[׳']/g, "$1סעיף"],
  [/(^|\s)ס["״]ק/g, "$1סעיף קטן"],
  [/(^|\s)פ[׳']/g, "$1פרק"],
  [/(^|\s)הל[׳']/g, "$1הלכות"],
  [/(^|\s)הל["״]/g, "$1הלכה"],
  [/(^|\s)מס[׳']/g, "$1מסכת"],
  [/(^|\s)דף\s/g, "$1דף "],
  [/(^|\s)עמ[׳']/g, "$1עמוד"],
  [/(^|\s)ד["״]ה/g, "$1דיבור המתחיל"],
  [/(^|\s)ח[׳']/g, "$1חלק"],
  [/(^|\s)שו["״]ע/g, "$1שולחן ערוך"],
  [/(^|\s)או["״]ח/g, "$1אורח חיים"],
  [/(^|\s)יו["״]ד/g, "$1יורה דעה"],
  [/(^|\s)אה["״]ע/g, "$1אבן העזר"],
  [/(^|\s)חו["״]מ/g, "$1חושן משפט"],
  [/(^|\s)מ["״]ב/g, "$1משנה ברורה"],
];

/** Removes vowel points and cantillation only. */
export const stripNikud = (s: unknown): string => String(s ?? "").replace(NIKUD_RE, "");

const normalizeImpl = boundedMemo((str: string) => {
  let t = str.replace(NIKUD_RE, "");
  for (const [re, to] of ABBREVIATIONS) t = t.replace(re, to);
  return t
    .replace(QUOTES_RE, "")
    .replace(/[.,;:()[\]{}־–—…]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
});

/** Full comparison normalization: nikud, structural abbreviations, quotes, punctuation, spaces. */
export const normalize = (s: unknown): string => normalizeImpl(String(s ?? ""));

const stemImpl = boundedMemo((x: string) => {
  const s = x.replace(PREFIX_RE, "");
  return s.length >= 3 ? s : x;
});

/** Removes one prefix letter, only if a root of ≥3 letters remains (prevents "בן" → "ן"). */
export const stem = (w: unknown): string => stemImpl(String(w ?? ""));

const skeletonImpl = boundedMemo((x: string) => {
  let s = x.replace(/[וי]/g, "");
  if (s.length >= 3) s = s.replace(/א$/, "ה").replace(/ן$/, "ם");
  return s;
});

/** Consonantal skeleton: no ו/י (plene vs defective spelling); final א↔ה, ן↔ם unified (from 3 letters). */
export const skeleton = (w: unknown): string => skeletonImpl(String(w ?? ""));
