import { foldQuery } from "../../core/text/find";
import { rangesOf } from "./book-find";

/*
 * Painting the words the engine matched (Suggestion.matched, issue #11) in a rendered reader line, with the CSS Custom
 * Highlight API where the browser has it (the card shows the same words everywhere). Kept apart from matched-words.ts so
 * that the pure cutting of a line stays testable in Node.
 */
declare const Highlight: { new (...ranges: Range[]): unknown } | undefined;

type HighlightApi = { highlights?: Map<string, unknown> };
const api = () => (globalThis as { CSS?: HighlightApi }).CSS;

/** The highlight name a reader paints the matched words with (styled in app.css). */
export const matchHighlight = (side: "source" | "target") => `match-${side}`;

/**
 * Paints `words` (the visible text the engine matched) in line `line` of a reader. They are found in the rendered text
 * by their folded text, first occurrence, and not by offset: the reader shows `text`, the engine counted `anchorText`
 * (schema 7 adds the footnote bodies), so raw offsets do not map onto the DOM.
 */
export function paintMatched(root: HTMLElement | null, side: "source" | "target", line: number | null, words: string | null): void {
  const h = api()?.highlights;
  if (!h || typeof Highlight === "undefined") return;
  const ranges: Range[] = [];
  const folded = words ? foldQuery(words) : "";
  if (root && line !== null && folded) {
    const el = root.querySelector<HTMLElement>(`.ln[data-i="${line}"] .tx`);
    const first = el ? rangesOf(el, folded)[0] : undefined;
    if (first) ranges.push(first);
  }
  h.set(matchHighlight(side), new Highlight(...ranges));
}

export function clearMatched(side: "source" | "target"): void {
  api()?.highlights?.delete(matchHighlight(side));
}
