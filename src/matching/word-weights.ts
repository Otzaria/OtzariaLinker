/*
 * How much evidence one matched word carries. Port of otzaria-link-generator
 * `src/utils/wordWeights.ts` @7ad8b2c (REUSE_MATRIX §1 row 3: "as is"), keyed on the search keys
 * of ./hebrew-tokens (final letters unified), so the stop-word list is stored in that form.
 *
 *   stop word 0.35 · ≤2 letters 0.45 · 3–5 letters 1.00 · ≥6 letters 1.25
 *   × a document IDF factor (frequent in >8% of lines → down to 0.35; rare <1% → 1.5)
 *   bounded to 0.25..1.30
 */
import { searchKey } from "./hebrew-tokens";

const STOP_WORDS_RAW = [
  "של", "על", "את", "אל", "מן", "עם", "בי", "לי", "לו", "לה", "לנו", "להם", "להן",
  "בו", "בה", "בנו", "בהם", "עליו", "עליה", "עליהם", "עלינו", "אצלו", "אצלה", "בתוך", "מתוך",
  "מאחר", "אחר", "לפני", "אחרי", "בין", "כמו", "כפי", "לפי", "מפני", "עקב", "בגלל",
  "למען", "בעבור", "אם", "כי", "זה", "זו", "אלה", "אלו", "אשר", "כל", "מה", "מי",
  "הוא", "היא", "הם", "הן", "אלא", "אפילו", "עד", "אבל", "כך", "כאן", "הכא", "התם",
  "היה", "היו", "יהיה", "יהיו", "אמר", "אמרו", "אמרת", "אמרתי", "נאמר", "אומר",
  "אומרים", "שם", "כו", "וכו", "וגו", "וגומר", "דהיינו", "פירוש", "פירש", "רב", "רבי",
  "ר", "בן", "בר", "בת", "לא", "כן", "גם", "אי", "או", "אינו", "אינה", "אינם",
  "יש", "אין", "הנה", "כבר", "עוד", "שוב", "רק", "אולי", "ממש", "כמעט",
];

/** Stop words as search keys (final letters unified). */
export const STOP_WORDS: ReadonlySet<string> = new Set(STOP_WORDS_RAW.map(searchKey));

export const MAX_WORD_WEIGHT = 1.3;

/** Static weight of one search key. */
export function staticWeight(key: string): number {
  if (!key) return 1;
  if (STOP_WORDS.has(key)) return 0.35;
  if (key.length <= 2) return 0.45;
  if (key.length >= 6) return 1.25;
  return 1;
}

/** IDF factors over a collection of lines, each given as its list of keys. */
export function idfFactors(lines: Iterable<readonly string[]>): Map<string, number> {
  const df = new Map<string, number>();
  let n = 0;
  for (const keys of lines) {
    n++;
    for (const k of new Set(keys)) df.set(k, (df.get(k) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  if (!n) return out;
  for (const [k, f] of df) {
    const ratio = f / n;
    out.set(k, ratio > 0.08 ? Math.max(0.35, 1 - ratio * 2) : ratio < 0.01 ? 1.5 : 1);
  }
  return out;
}

/** Combined weight: static × IDF, bounded 0.25..1.30. Without `idf` (or with weighting off) the IDF factor is 1. */
export function wordWeight(key: string, idf?: ReadonlyMap<string, number>, enabled = true): number {
  if (!enabled || !key) return 1;
  const f = idf?.get(key) ?? 1;
  return Math.min(MAX_WORD_WEIGHT, Math.max(0.25, staticWeight(key) * f));
}
