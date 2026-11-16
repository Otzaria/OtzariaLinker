/*
 * Pattern engine (v3's "לפי תבנית", FEATURE_INVENTORY F-100/F-101), grown into a structure-reference
 * toolkit: a preset or a user template finds references in each source line, and each one names a
 * line, a line of a chapter, or a place in the target's heading tree. Pure; runs in the worker.
 * See engine.ts, presets.ts, template.ts, tree.ts.
 */
export { DEFAULT_PATTERN, readReferences, runPatternEngine, type PatternOptions, type PatternTarget } from "./engine";
export { bookMatches, otherBook } from "./books";
export { parseAmud, parseRefNumeral, type RefNumber } from "./numerals";
export { CUSTOM_PRESET, DEFAULT_PRESET, PATTERN_PRESETS, presetById, type PatternPreset } from "./presets";
export { compilePattern, describeLevels } from "./template";
