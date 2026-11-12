/*
 * The Dibur Hamatchil (ד"ה) engine — public API. See engine.ts for the algorithm and
 * docs/research/DH_ANCHOR_DIRECTION.md for the record shape it emits.
 */
export { runDiburHamatchilEngine, anchorPolicy, type DhOptions } from "./engine";
export { extractDh, DEFAULT_MAX_DH_WORDS, type ExtractedDh, type DhLineKind, type DhBoundary } from "./extract";
export { matchConfidence, inheritedConfidence, dynamicMinThreshold, type MatchEvidence, type Rung } from "./confidence";
export { bestRun, qualifyingOccurrence, orderFactor, STRICT_SPEC, type SearchSpec, type Run } from "./search";
export { headingWindowPlan, headingWindows, widen, type HeadingWindows, type SearchWindow, type WindowKind } from "./windows";
