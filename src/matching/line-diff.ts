import { searchKey } from "./hebrew-tokens";

/*
 * Line alignment between two editions of a book (stage 11). Three passes, from most to least sure:
 *   1. patience: lines that occur exactly once in both editions and keep their order are anchors;
 *   2. LCS inside each gap between anchors (exact text, bounded work);
 *   3. edited lines: an unmatched old line pairs with an unmatched new line in the same gap when
 *      their words are similar enough — and the pair is only "changed", never "same".
 * The result says, per old line, where it went and how sure that is. Nothing here moves links.
 */
export type LineFate = "unique" | "same" | "changed" | "deleted";

export interface LineMapping {
  /** old line index → new line index, or -1 */
  readonly to: Int32Array;
  readonly fate: readonly LineFate[];
  /** word similarity of a "changed" pair, 1 for exact */
  readonly similarity: Float32Array;
  readonly stats: Record<LineFate, number> & { inserted: number };
}

export interface DiffOptions {
  /** minimum word similarity (0..1) for an edited line to count as the same line. Default 0.6 */
  minSimilarity?: number;
  /** LCS cells allowed per gap; larger gaps rely on anchors only. Default 4M */
  maxCells?: number;
}

export function diffLines(oldLines: readonly string[], newLines: readonly string[], opts: DiffOptions = {}): LineMapping {
  const minSim = opts.minSimilarity ?? 0.6;
  const maxCells = opts.maxCells ?? 4_000_000;
  const to = new Int32Array(oldLines.length).fill(-1);
  const fate: LineFate[] = new Array<LineFate>(oldLines.length).fill("deleted");
  const similarity = new Float32Array(oldLines.length);
  const usedNew = new Uint8Array(newLines.length);

  const link = (i: number, j: number, f: LineFate, s = 1) => {
    to[i] = j;
    fate[i] = f;
    similarity[i] = s;
    usedNew[j] = 1;
  };

  // pass 1 + 2, recursively per gap
  const stack: [number, number, number, number][] = [[0, oldLines.length, 0, newLines.length]];
  const gaps: [number, number, number, number][] = [];
  while (stack.length) {
    const [a0, a1, b0, b1] = stack.pop()!;
    if (a0 >= a1 || b0 >= b1) continue;
    const anchors = uniqueAnchors(oldLines, newLines, a0, a1, b0, b1);
    if (anchors.length) {
      let pa = a0;
      let pb = b0;
      for (const [i, j] of anchors) {
        link(i, j, "unique");
        stack.push([pa, i, pb, j]);
        pa = i + 1;
        pb = j + 1;
      }
      stack.push([pa, a1, pb, b1]);
      continue;
    }
    if ((a1 - a0) * (b1 - b0) <= maxCells) for (const [i, j] of lcs(oldLines, newLines, a0, a1, b0, b1)) link(i, j, "same");
    gaps.push([a0, a1, b0, b1]);
  }

  // pass 3: edited lines, in order, inside each gap
  for (const [a0, a1, b0, b1] of gaps) {
    let j = b0;
    for (let i = a0; i < a1; i++) {
      if (to[i] !== -1) {
        j = Math.max(j, to[i]! + 1);
        continue;
      }
      // the next matched old line bounds where this one may go
      let limit = b1;
      for (let k = i + 1; k < a1; k++) if (to[k] !== -1) { limit = to[k]!; break; }
      let best = -1;
      let bestSim = minSim;
      const ki = words(oldLines[i]!);
      for (let c = j; c < limit && c < j + 50; c++) {
        if (usedNew[c]) continue;
        const s = wordJaccard(ki, words(newLines[c]!));
        if (s >= bestSim) { best = c; bestSim = s; }
      }
      if (best >= 0) {
        link(i, best, "changed", bestSim);
        j = best + 1;
      }
    }
  }

  const stats = { unique: 0, same: 0, changed: 0, deleted: 0, inserted: 0 };
  for (const f of fate) stats[f]++;
  for (let j = 0; j < newLines.length; j++) if (!usedNew[j]) stats.inserted++;
  return { to, fate, similarity, stats };
}

/** Lines unique in both ranges, kept only where their order agrees (longest increasing subsequence). */
function uniqueAnchors(A: readonly string[], B: readonly string[], a0: number, a1: number, b0: number, b1: number): [number, number][] {
  const count = (L: readonly string[], f: number, t: number) => {
    const m = new Map<string, number>();
    for (let i = f; i < t; i++) m.set(L[i]!, m.has(L[i]!) ? -1 : i);
    return m;
  };
  const ua = count(A, a0, a1);
  const ub = count(B, b0, b1);
  const pairs: [number, number][] = [];
  for (const [text, i] of ua) {
    if (i < 0 || !text.trim()) continue;
    const j = ub.get(text);
    if (j !== undefined && j >= 0) pairs.push([i, j]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  return longestIncreasing(pairs);
}

function longestIncreasing(pairs: [number, number][]): [number, number][] {
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  const at: number[] = [];
  for (let k = 0; k < pairs.length; k++) {
    const v = pairs[k]![1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1]!;
    tails[lo] = k;
    at[lo] = k;
  }
  const out: [number, number][] = [];
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!) out.push(pairs[k]!);
  return out.reverse();
}

function lcs(A: readonly string[], B: readonly string[], a0: number, a1: number, b0: number, b1: number): [number, number][] {
  const n = a1 - a0;
  const m = b1 - b0;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * (m + 1) + j] = A[a0 + i] === B[b0 + j] ? dp[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(dp[(i + 1) * (m + 1) + j]!, dp[i * (m + 1) + j + 1]!);
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[a0 + i] === B[b0 + j]) {
      if (A[a0 + i]!.trim()) out.push([a0 + i, b0 + j]);
      i++;
      j++;
    } else if (dp[(i + 1) * (m + 1) + j]! >= dp[i * (m + 1) + j + 1]!) i++;
    else j++;
  }
  return out;
}

const words = (line: string): Set<string> => new Set(searchKey(line).split(" ").filter((w) => w.length > 1));

function wordJaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
