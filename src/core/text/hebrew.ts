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

/** A string folded for text search, with where each folded char came from. */
export interface Folded {
  readonly text: string;
  /** map[i] = index in the input of folded char i */
  readonly map: readonly number[];
}

/*
 * What foldForSearch does with each UTF-16 unit: KEEP it, DROP it, or make it a SPACE. A table, not
 * regexes per char: the in-book search folds every line of a book, so this loop is the hot path.
 */
const KEEP = 0;
const DROP = 1;
const SPACE = 2;
const FOLD_CLASS = (() => {
  const t = new Uint8Array(0x10000);
  for (let c = 0; c <= 0x20; c++) t[c] = SPACE;
  for (let c = 0x591; c <= 0x5c7; c++) t[c] = DROP; // nikud and cantillation
  // maqaf, paseq, sof pasuq, nun hafukha: inside that block, but they SEPARATE words (as in hebrew-tokens)
  for (const c of "־׀׃׆") t[c.charCodeAt(0)] = SPACE;
  for (const c of "\"'׳״‘’“”`´″„‟") t[c.charCodeAt(0)] = DROP; // quote marks of every kind
  for (const c of [0xad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0xfeff]) t[c] = DROP; // invisible
  for (const c of ".,;:!?()[]{}-–—…‐‑‒―") t[c.charCodeAt(0)] = SPACE;
  for (const c of [0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000]) t[c] = SPACE;
  for (let c = 0x2000; c <= 0x200a; c++) t[c] = SPACE;
  return t;
})();

/**
 * Search folding for text inside a book: the same rules as `normalize` (nikud and cantillation
 * dropped, quote marks dropped, punctuation and runs of spaces become one space), with three
 * differences that a search in running text needs:
 *   • no abbreviation expansion — the user looks for what is written ("סי'" is not "סימן");
 *   • maqaf, paseq and sof pasuq separate words ("כל־האדם" is found by "כל האדם");
 *   • every folded char keeps its position in the input, so a match maps back to the original
 *     text for a snippet or a highlight. Latin letters are lower-cased.
 * The result never starts with a space; it may end with one.
 */
export function foldForSearch(input: unknown): Folded {
  const s = String(input ?? "");
  const codes: number[] = [];
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    const k = FOLD_CLASS[c]!;
    if (k === DROP) continue;
    if (k === SPACE) {
      if (codes.length && codes[codes.length - 1] !== 0x20) codes.push(0x20), map.push(i);
      continue;
    }
    if (c >= 0x41 && c <= 0x5a) c += 0x20;
    else if (c >= 0xc0 && (c < 0x5d0 || c > 0x5ea)) {
      const lower = s[i]!.toLowerCase();
      if (lower.length === 1) c = lower.charCodeAt(0); // a lower case that is longer would break the map
    }
    codes.push(c);
    map.push(i);
  }
  let text = "";
  for (let i = 0; i < codes.length; i += 8192) text += String.fromCharCode(...codes.slice(i, i + 8192));
  return { text, map };
}

/** A search query folded like the text it is matched against, without edge spaces. */
export const foldQuery = (q: unknown): string => foldForSearch(q).text.trim();
