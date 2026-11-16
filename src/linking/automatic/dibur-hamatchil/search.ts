/*
 * The continuous weighted search of a ד"ה in base lines — port of `calcContiguousScore`,
 * `hasQualifyingOccurrence` and the candidate loop of `searchLineInDoc` (otzaria-link-generator
 * parserAlgorithm.ts:1865-2350 @7ad8b2c), and of the unique-anchor path (single-word ד"ה,
 * source lines 3050-3151).
 *
 * The anchor policy is kept exactly:
 *   • commentary side — a run must START within the first `maxStartIdx` (3) words of the ד"ה;
 *   • base side — a run starting in the first `shallowLimit` (3) words of the line is accepted at
 *     any length ("shallow"); deeper in the line only with at least `deepMinRun` (3) words (BUG-02)
 *     — CHANGED: or when it covers the whole ד"ה. The source rejected a two-word ד"ה quoting the
 *     middle of a verse ("בתוך המים" in "ויאמר אלהים יהי רקיע בתוך המים"), a lemma רש"י on the
 *     Torah quotes all the time; the rule was tuned on long Gemara lines;
 *   • `requireTargetStart` pins the run to the base line's first word (the base is itself a
 *     ד"ה-style commentary, e.g. a super-commentary on רש"י).
 * Changes: words are tokens with raw offsets (the run reports WHICH base words matched, for the
 * anchor); abbreviations are bridged by ../../../matching/token-match instead of the 1.3MB
 * dictionary; a run that reaches the end of a base line may continue into the next line (a ד"ה
 * that spans two lines → a target range).
 */
import type { HebToken } from "../../../matching/hebrew-tokens";
import { matchStep, type StepKind } from "../../../matching/token-match";

export interface SearchSpec {
  /** a run must start within this many words of the ד"ה */
  readonly maxStartIdx: number;
  /** base-side start positions below this are "shallow" */
  readonly shallowLimit: number;
  /** a deeper start needs at least this many base words */
  readonly deepMinRun: number;
  /** the run must start at the base line's first word */
  readonly requireTargetStart: boolean;
  /** use document IDF in word weights (rung B turns it off) */
  readonly useIdf: boolean;
  /** threshold multiplier: 0.65 normally, 0.4 on rung D */
  readonly multiplier: number;
  readonly fuzzy: boolean;
}

export const STRICT_SPEC: SearchSpec = {
  maxStartIdx: 3,
  shallowLimit: 3,
  deepMinRun: 3,
  requireTargetStart: false,
  useIdf: true,
  multiplier: 0.65,
  fuzzy: true,
};

export interface Run {
  /** weighted score of the run */
  readonly score: number;
  readonly simSum: number;
  /** ד"ה items consumed (an acronym bridged to several words counts once) */
  readonly srcStart: number;
  readonly srcUsed: number;
  /** token indices in the searched target sequence, [tgtStart, tgtEnd) */
  readonly tgtStart: number;
  readonly tgtEnd: number;
  /** steps in the run */
  readonly steps: number;
  readonly kinds: ReadonlySet<StepKind>;
}

/**
 * Best contiguous run of `src` inside `tgt`. Start positions on the target side are limited to
 * `startLimit` (the length of the first line when `tgt` is two lines joined), so a run may
 * CONTINUE into the second line but never start there.
 *
 * `starts` (optional, the same result either way): for each s0, the target positions (ascending)
 * where a step from src[s0] may start — a superset of those where matchStep would step (token-match.ts
 * `mayStep`, `StepVocabulary`). Only those are tried: otherwise every word of the line is tried
 * against each of the first words of the ד"ה, and almost no pair has a step.
 *
 * `joinWith` (optional): the next line's tokens, as if `tgt.concat(joinWith)` were passed — joined
 * only when a start is found, since runs may continue there but never start there.
 */
export function bestRun(
  src: readonly HebToken[],
  srcWeights: readonly number[],
  tgt: readonly HebToken[],
  tgtWeight: (key: string) => number,
  spec: SearchSpec,
  startLimit = tgt.length,
  starts?: (s0: number) => readonly number[],
  joinWith?: readonly HebToken[],
): Run | null {
  const first = tgt;
  let joined: readonly HebToken[] | null = joinWith ? null : tgt;
  const maxS = Math.min(spec.maxStartIdx, src.length);
  const maxT = spec.requireTargetStart ? Math.min(1, startLimit) : startLimit;
  let best: Run | null = null;
  let all: number[] | null = null;
  for (let s0 = 0; s0 < maxS; s0++) {
    for (const t0 of starts ? starts(s0) : (all ??= Array.from({ length: maxT }, (_, k) => k))) {
      if (t0 >= maxT) break;
      tgt = joined ??= first.concat(joinWith!);
      let st = matchStep(src, s0, tgt, t0, spec.fuzzy);
      if (!st) continue;
      let i = s0;
      let j = t0;
      let score = 0;
      let simSum = 0;
      let steps = 0;
      const kinds = new Set<StepKind>();
      for (; st; st = i < src.length && j < tgt.length ? matchStep(src, i, tgt, j, spec.fuzzy) : null) {
        let sw = 0;
        for (let k = 0; k < st.a; k++) sw += srcWeights[i + k]!;
        let tw = 0;
        if (st.b > 1) for (let k = 0; k < st.b; k++) tw += tgtWeight(tgt[j + k]!.key);
        // FIX ח׳ of the source: an expansion keeps one slot and contributes a damped share
        const w = st.a === 1 && st.b > 1 ? Math.max(sw, 0.6 * tw) : st.a > 1 ? 0.6 * sw : sw;
        score += st.sim * w;
        simSum += st.sim;
        steps++;
        kinds.add(st.kind);
        i += st.a;
        j += st.b;
      }
      // deep in the line, a FRAGMENT of the ד"ה needs a run of deepMinRun words; the whole ד"ה is
      // accepted anywhere (a lone one-word ד"ה then competes with its other occurrences, and the
      // engine reports the tie as ambiguous instead of hiding the rivals)
      if (t0 >= spec.shallowLimit && j - t0 < spec.deepMinRun && !(s0 === 0 && i >= src.length)) continue;
      if (!best || score > best.score) best = { score, simSum, srcStart: s0, srcUsed: i - s0, tgtStart: t0, tgtEnd: j, steps, kinds };
    }
  }
  return best;
}

/**
 * The whole phrase `src` as consecutive whole words of `tgt` (search keys) — at word 0 when the
 * target must start there, anywhere otherwise (the whole ד"ה is never a deep "fragment").
 * Returns the token index, or -1.
 */
export function qualifyingOccurrence(src: readonly HebToken[], tgt: readonly HebToken[], spec: SearchSpec, startLimit = tgt.length): number {
  const n = src.length;
  if (!n) return -1;
  const last = Math.min(startLimit, tgt.length - n + 1);
  for (let t0 = 0; t0 < last; t0++) {
    if (spec.requireTargetStart && t0 > 0) break;
    let ok = true;
    for (let k = 0; k < n && ok; k++) ok = src[k]!.key === tgt[t0 + k]!.key;
    if (!ok) continue;
    return t0; // the whole phrase: accepted at any depth (see bestRun)
  }
  return -1;
}

/** Sequential-order nudge of the source (max −7% backwards, −5% far forwards). */
export function orderFactor(line: number, prev: number | null): number {
  if (prev === null) return 1;
  const diff = line - prev;
  if (diff < 0) return Math.max(0.93, 1 - Math.abs(diff) * 0.005);
  if (diff > 5) return Math.max(0.95, 1 - (diff - 5) * 0.002);
  return 1;
}
