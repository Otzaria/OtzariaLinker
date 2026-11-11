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

export type Rung = "A" | "B" | "C" | "D";

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
  RUNG_PENALTY: { A: 0.45, B: 0.8, C: 1.25, D: 1.85 } as Record<Rung, number>,
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
