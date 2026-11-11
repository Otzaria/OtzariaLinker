import { normalize, skeleton, stem } from "../core/text/hebrew";

/** Edit distance with an early exit when the length gap alone exceeds `max`. */
export function levenshtein(x: unknown, y: unknown, max = Infinity): number {
  const a = String(x ?? "");
  const b = String(y ?? "");
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > max) return Math.abs(a.length - b.length);
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** "Light flexibility only": a short word must match exactly — otherwise "לא" ≈ "לה". */
export const maxEdits = (len: number): number => (len <= 3 ? 0 : len <= 6 ? 1 : 2);

/** Similarity of two words, 0..1, symmetric. exact 1 · same stem .92 · spelling .88 · fuzzy .70–.95 */
export function wordSimilarity(a: unknown, b: unknown): number {
  const w1 = String(a ?? "");
  const w2 = String(b ?? "");
  if (w1 === w2) return 1;
  if (!w1 || !w2) return 0;
  const s1 = stem(w1);
  const s2 = stem(w2);
  if (s1 === s2) return 0.92;
  const k1 = skeleton(s1);
  const k2 = skeleton(s2);
  if (k1.length >= 2 && k1 === k2) return 0.88;
  const lim = maxEdits(Math.max(s1.length, s2.length));
  if (!lim) return 0;
  const d = levenshtein(s1, s2, lim);
  if (d > lim) return 0;
  return Math.max(0.7, 0.95 - d * 0.12);
}

function greedy(A: readonly string[], B: readonly string[]): number {
  const used = new Array<boolean>(B.length).fill(false);
  let total = 0;
  for (const w of A) {
    let best = 0;
    let bestIdx = -1;
    for (let i = 0; i < B.length; i++) {
      if (used[i]) continue;
      const s = wordSimilarity(w, B[i]);
      if (s > best) { best = s; bestIdx = i; }
    }
    if (bestIdx >= 0) used[bestIdx] = true;
    total += best;
  }
  return total;
}

/**
 * Similarity of two phrases (headings), 0..1. Necessarily SYMMETRIC: greedy matching depends on
 * direction (an early match can block a better one), so both directions run and the better wins —
 * otherwise the same pair scores differently depending on which side is the source.
 */
export function phraseSimilarity(a: unknown, b: unknown): number {
  const A = normalize(a).split(" ").filter(Boolean);
  const B = normalize(b).split(" ").filter(Boolean);
  if (!A.length || !B.length) return 0;
  if (A.join(" ") === B.join(" ")) return 1;
  const total = Math.max(greedy(A, B), greedy(B, A));
  // Normalize by the longer side, so "סימן א" vs "סימן א סעיף ב" is not 1.0; mild length penalty.
  const score = total / Math.max(A.length, B.length);
  const lenRatio = Math.min(A.length, B.length) / Math.max(A.length, B.length);
  return Math.max(0, Math.min(1, score * (0.75 + 0.25 * lenRatio)));
}
