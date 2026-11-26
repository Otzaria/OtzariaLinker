/*
 * Calibrated confidence of a ד"ה match — port of `calculateLinkConfidence` and `CONF` from
 * otzaria-link-generator parserAlgorithm.ts:284-461 @7ad8b2c (REUSE_MATRIX §1 row 4: "port: the
 * calibration is expensive to produce and data-based"). Six normalized signals are combined in
 * log-odds and passed through a logistic, then Platt-scaled (A=0.5163, B=0.1358, fitted on 895
 * links of three commentary/tractate pairs). Ladder rungs are log-odds PENALTIES; an inherited
 * link is its parent's probability × 0.8 per hop.
 *
 * Changes from the source: the result is 0..1 (not a rounded percent), and the multi-pass
 * "pass ladder" term is dropped (this engine runs one pass; windows come from the caller).
 * Also the acceptance threshold (`dynamicMinThreshold`, source lines 150-190) lives here.
 */

/** A–D: the relaxations of the search; L: the letters of the ד"ה found by edit distance (rung L, engine.ts) */
export type Rung = "A" | "B" | "C" | "D" | "L";

/** What the search measured about the match it returned. */
export interface MatchEvidence {
  /** weight of the matched contiguous run */
  readonly matchedWeight: number;
  /** weight of the words the matcher was allowed to compare */
  readonly windowWeight: number;
  /** words in the run */
  readonly runWords: number;
  /** sum of per-word similarities over the run */
  readonly simSum: number;
  /** ranking score of this candidate */
  readonly winnerScore: number;
  /** best ranking score among its rivals (0 = none) */
  readonly runnerUpScore: number;
  /** the whole search phrase occurs verbatim (after search normalization) */
  readonly exactPhrase: boolean;
}

const CONF = {
  B0: 0.35,
  W_COVERAGE: 3.2, C_COVERAGE: 0.5,
  W_RUN: 2.4, C_RUN: 0.55,
  W_SIM: 2.6, C_SIM: 0.9,
  W_INFO: 1.1, C_INFO: 0.55,
  W_MARGIN: 1.7, C_MARGIN: 0.35,
  W_EXACT: 1.15,
  W_EXPLICIT: 0.45,
  RUN_SCALE: 3.5,
  MAX_WORD_WEIGHT: 1.3,
  RUNG_PENALTY: { A: 0.45, B: 0.8, C: 1.25, D: 1.85, L: 0.8 } as Record<Rung, number>,
  CAL_A: 0.5163,
  CAL_B: 0.1358,
  INHERIT_RETENTION: 0.8,
  INHERIT_FALLBACK: 0.7,
  MIN: 0.05,
  MAX: 0.99,
} as const;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const logistic = (z: number) => 1 / (1 + Math.exp(-z));
const clampP = (p: number) => Math.max(CONF.MIN, Math.min(CONF.MAX, Math.round(p * 1000) / 1000));

export interface ConfidenceInputs {
  readonly evidence: MatchEvidence | null;
  /** the line marks its own ד"ה boundary */
  readonly explicit: boolean;
  readonly rung: Rung | null;
}

/** Calibrated probability (0.05..0.99) that a directly matched link is right. */
export function matchConfidence(inp: ConfidenceInputs): number {
  const toP = (z: number) => clampP(logistic(CONF.CAL_A * z + CONF.CAL_B));
  const ev = inp.evidence;
  const rungPenalty = inp.rung ? CONF.RUNG_PENALTY[inp.rung] : 0;
  if (!ev || ev.runWords <= 0 || ev.windowWeight <= 0) return toP(CONF.B0 - rungPenalty);

  const coverage = clamp01(ev.matchedWeight / ev.windowWeight);
  const runF = 1 - Math.exp(-ev.runWords / CONF.RUN_SCALE);
  const meanSim = clamp01(ev.simSum / ev.runWords);
  const info = clamp01(ev.matchedWeight / ev.runWords / CONF.MAX_WORD_WEIGHT);
  const margin = ev.winnerScore > 0 ? clamp01((ev.winnerScore - ev.runnerUpScore) / ev.winnerScore) : 0;

  let z =
    CONF.B0 +
    CONF.W_COVERAGE * (coverage - CONF.C_COVERAGE) +
    CONF.W_RUN * (runF - CONF.C_RUN) +
    CONF.W_SIM * (meanSim - CONF.C_SIM) +
    CONF.W_INFO * (info - CONF.C_INFO) +
    CONF.W_MARGIN * (margin - CONF.C_MARGIN);
  if (ev.exactPhrase) z += CONF.W_EXACT;
  if (inp.explicit) z += CONF.W_EXPLICIT;
  return toP(z - rungPenalty);
}

/** What the placement of one ד"ה rests on, beyond the match itself (#41 B2, #42 C9). */
export interface PlacementEvidence {
  /** words of the ד"ה that matched (a unique anchor: its words) */
  readonly words: number;
  /** the search window is the whole base: no heading of the commentary narrowed it (dh/window-book) */
  readonly wholeBook: boolean;
  /** other lines of the window that hold the same words as the place chosen */
  readonly repeats: number;
}

/**
 * The highest confidence the evidence allows when the search window is the WHOLE base, with the rule that capped it, or
 * null. The calibrated probability measures how well the words match, not how many places they would match: a word or
 * two, or a phrase that stands in other lines, found without a heading that narrows the search, is placed by the order of
 * the walk. Findings #41 B2 (one word, whole base, "high": 52 right / 21 wrong; three words 313 / 5) and #42 C9 (a repeated
 * phrase of three words at "high" 19 / 4; a phrase found once 280 / 0). Calibrated on the tuning half of the V7 benchmark's
 * no-headings set (docs/validation/V7_MATCHING_BENCHMARK.md §3): one word "high" 167/180 (92.8%; repeated 30/37), two words
 * 646/663 (97.4%), a repeated phrase of three words 57/60 at "high" — so:
 *   - one word → "possible";
 *   - two words → "high" at most;
 *   - a phrase that stands in other lines of the base → "high" at most (never "certain"), the other lines as alternatives.
 * Inside a heading's window none of this applies: there the rivals are near, and the search meets them (a repeated phrase at
 * "certain" in a heading window: 38/38 in the same benchmark).
 */
export function evidenceCap(e: PlacementEvidence): { cap: "high" | "possible"; rule: string } | null {
  if (!e.wholeBook) return null;
  if (e.words <= 1) return { cap: "possible", rule: "dh/short-whole-book" };
  if (e.repeats > 0) return { cap: "high", rule: "dh/repeated-phrase" };
  if (e.words === 2) return { cap: "high", rule: "dh/short-whole-book" };
  return null;
}

/** An inherited link (בא"ד / שם): the parent's claim, weakened once per hop. */
export function inheritedConfidence(parent: number | null, depth: number): number {
  const p = parent && parent > 0 ? parent : CONF.INHERIT_FALLBACK;
  return clampP(p * Math.pow(CONF.INHERIT_RETENTION, Math.max(1, depth)));
}

/**
 * Acceptance bar for a run score (link-generator `computeDynamicMinThreshold`, BUG-01 fix): fewer
 * words → lower fraction; a line without an explicit ד"ה boundary needs 5 points more; the
 * multiplier (0.65 normally, 0.4 on rung D) scales the fraction; capped at `cap`.
 */
export function dynamicMinThreshold(expectedWeight: number, wordCount: number, explicit: boolean, multiplier = 0.65, cap = 1.5): number {
  let fraction: number;
  let floor: number;
  if (wordCount <= 2) {
    fraction = 0.55;
    floor = 0.4;
  } else if (wordCount <= 4) {
    fraction = 0.6;
    floor = 0.55;
  } else {
    fraction = 0.65;
    floor = 0.7;
  }
  if (!explicit) fraction += 0.05;
  return Math.min(cap, Math.max(floor, expectedWeight * fraction * (multiplier / 0.65)));
}
