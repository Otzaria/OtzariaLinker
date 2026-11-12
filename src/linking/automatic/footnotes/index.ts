/*
 * Footnotes engine (plan stage 8.3): links each footnote MARKER in a book to the line of the notes
 * book that opens with the same marker. Pure; runs in the worker. See engine.ts for the options and
 * markers.ts for what counts as a marker.
 */
export { runFootnotesEngine, type FootnotesOptions } from "./engine";
export {
  appRecognisesMarker, checkCustomPattern, compileStyle, detectMarkers, labelCommentators, leadingMarker, parseMarkerToken, MAX_CUSTOM_REGEX_INPUT,
  type CompiledStyle, type DetectOptions, type Marker, type MarkerStyle, type Numbering, type ParsedToken, type PatternCheck,
} from "./markers";
