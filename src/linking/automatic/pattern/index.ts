/*
 * Pattern engine (v3's "לפי תבנית", FEATURE_INVENTORY F-100/F-101): a user regular expression finds a
 * number in each source line, and the number names a line, a line of a chapter, or a heading of the
 * target. Pure; runs in the worker. See engine.ts.
 */
export { DEFAULT_PATTERN, runPatternEngine, type PatternOptions, type PatternTarget } from "./engine";
