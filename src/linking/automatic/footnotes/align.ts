import type { Chapter, Occ } from "./chapters";

/*
 * Which notes chapter does each marker of the book belong to? — a GLOBAL alignment.
 *
 * Link-Notes decides greedily, marker by marker (shouldAdvanceBookChapter + a rescue pass). That
 * needs a few linked markers of evidence before it may advance, so it never leaves a SHORT chapter
 * (one or two notes): the next chapter's "1" is taken as a back-reference to the current "1", and
 * every later chapter stays shifted. Measured on 25 real books it linked 6% correctly in a book of
 * 142 short chapters (איסור והיתר הארוך).
 *
 * Here the chapters of all markers are chosen together (Viterbi / min-sum dynamic programming): a
 * marker whose number is missing from its chapter costs MISS, moving on costs ADV (less when the
 * marker is the first number of the new chapter, less again when both books have a heading there),
 * skipping a chapter costs SKIP, and staying with a number that does not grow costs STAY_SAME /
 * STAY_DOWN (a back-reference is possible but unusual). Chapters only move forward. The cheapest
 * path wins; for every marker the MARGIN — how much more the best path that puts it in another
 * chapter would cost — says how sure the choice is.
 */
const COST = {
  miss: 1,
  staySame: 0.3,
  stayDown: 0.6,
  adv: 0.3,
  advFirstKey: -0.2,
  advHeading: -0.1,
  skip: 0.5,
  /** per notes chapter left unused at the end */
  tail: 0.25,
} as const;

/** Above this many marker×chapter cells the alignment is not run (memory); the greedy walk is used. */
export const MAX_ALIGN_CELLS = 4_000_000;

export interface Aligned {
  /** chapter index (into the given chapters) of each marker */
  readonly chapterOf: Int32Array;
  /** cost difference to the best alternative chapter (Infinity when there is only one chapter) */
  readonly margin: Float64Array;
}

export function alignChapters(occs: readonly Occ[], chapters: readonly Chapter[], headingBetween: (a: number, b: number) => boolean): Aligned | null {
  const m = occs.length;
  const n = chapters.length;
  const chapterOf = new Int32Array(m);
  const margin = new Float64Array(m).fill(Infinity);
  if (!m || n <= 1) return { chapterOf, margin };
  if (m * n > MAX_ALIGN_CELLS) return null;

  const firstKey = chapters.map((c) => c.occs[0]!.marker.key);
  const emit = (i: number, c: number) => (chapters[c]!.keyToLines.has(occs[i]!.marker.key) ? 0 : COST.miss);
  const stay = (i: number) => {
    const d = occs[i]!.marker.num - occs[i - 1]!.marker.num;
    return d > 0 ? 0 : d === 0 ? COST.staySame : COST.stayDown;
  };
  /** cost of entering chapter c at marker i from an earlier chapter (without the skip part) */
  const enter = (i: number, c: number) => {
    let v = COST.adv;
    if (occs[i]!.marker.key === firstKey[c]) v += COST.advFirstKey;
    if (i > 0 && chapters[c]!.afterHeading && headingBetween(occs[i - 1]!.line, occs[i]!.line)) v += COST.advHeading;
    return v;
  };

  // forward: alpha[i*n+c] = best cost of markers 0..i with marker i in chapter c (emission included)
  const alpha = new Float32Array(m * n);
  const back = new Int32Array(m * n);
  for (let c = 0; c < n; c++) alpha[c] = COST.skip * c + emit(0, c);
  for (let i = 1; i < m; i++) {
    const prev = (i - 1) * n;
    const cur = i * n;
    const s = stay(i);
    // best earlier chapter c' for entering c: min over c' < c of alpha[c'] + skip*(c-c'-1)
    let bestVal = Infinity;
    let bestArg = -1;
    for (let c = 0; c < n; c++) {
      let v = alpha[prev + c]! + s;
      let arg = c;
      if (bestArg >= 0) {
        const adv = bestVal + COST.skip * (c - 1) + enter(i, c);
        if (adv < v) {
          v = adv;
          arg = bestArg;
        }
      }
      alpha[cur + c] = v + emit(i, c);
      back[cur + c] = arg;
      const cand = alpha[prev + c]! - COST.skip * c;
      if (cand < bestVal) {
        bestVal = cand;
        bestArg = c;
      }
    }
  }

  // backward: beta[i*n+c] = best cost of markers i+1..m-1 given marker i is in chapter c
  const beta = new Float32Array(m * n);
  for (let c = 0; c < n; c++) beta[(m - 1) * n + c] = COST.tail * (n - 1 - c);
  for (let i = m - 2; i >= 0; i--) {
    const cur = i * n;
    const nxt = (i + 1) * n;
    const s = stay(i + 1);
    // from c: stay in c, or enter some c2 > c: min over c2 > c of enter + skip*(c2-c-1) + emit + beta
    let bestVal = Infinity; // min over c2 > c of (enter(i+1,c2) + emit(i+1,c2) + beta[c2] + skip*c2)
    for (let c = n - 1; c >= 0; c--) {
      const stayCost = s + emit(i + 1, c) + beta[nxt + c]!;
      const advCost = bestVal === Infinity ? Infinity : bestVal - COST.skip * (c + 1);
      beta[cur + c] = Math.min(stayCost, advCost);
      const cand = enter(i + 1, c) + emit(i + 1, c) + beta[nxt + c]! + COST.skip * c;
      if (cand < bestVal) bestVal = cand;
    }
  }

  // decode the best path
  let end = 0;
  for (let c = 1; c < n; c++) if (alpha[(m - 1) * n + c]! + beta[(m - 1) * n + c]! < alpha[(m - 1) * n + end]! + beta[(m - 1) * n + end]!) end = c;
  chapterOf[m - 1] = end;
  for (let i = m - 1; i > 0; i--) chapterOf[i - 1] = back[i * n + chapterOf[i]!]!;

  // min-marginal margins
  for (let i = 0; i < m; i++) {
    const row = i * n;
    const chosen = alpha[row + chapterOf[i]!]! + beta[row + chapterOf[i]!]!;
    let other = Infinity;
    for (let c = 0; c < n; c++) if (c !== chapterOf[i]) other = Math.min(other, alpha[row + c]! + beta[row + c]!);
    margin[i] = other - chosen;
  }
  return { chapterOf, margin };
}
