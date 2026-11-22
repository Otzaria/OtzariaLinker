import type { MatchedSpan } from "../../linking/automatic";
import { visibleBetween, visibleMap } from "../../core/text/visible-map";

/*
 * The words the engine matched (Suggestion.matched, issue #11), cut out of a line for the card. The span is raw UTF-16
 * offsets into the line as stored — the engine's `text`, the same convention as an anchor (AGENTS.md 2.4) — and the text
 * shown is the visible text of that line (visibleMap: tags hidden, an entity one character), so a span over `<b>…</b>`
 * gives the words inside. A long line is clipped to a window of words around the match (`windowWords` each side), because
 * the card shows a few lines and the match must not be cut off.
 */
export interface MatchedParts {
  readonly before: string;
  readonly match: string;
  readonly after: string;
  readonly clippedBefore: boolean;
  readonly clippedAfter: boolean;
}

export const MATCH_WINDOW_WORDS = 14;

export function splitMatched(line: string, span: MatchedSpan | undefined, windowWords = MATCH_WINDOW_WORDS): MatchedParts | null {
  if (!span || span.rawEnd <= span.rawStart || span.rawStart >= line.length) return null;
  const map = visibleMap(line);
  const match = visibleBetween(map, span.rawStart, span.rawEnd);
  if (!match.trim()) return null;
  let before = visibleBetween(map, 0, span.rawStart);
  let after = visibleBetween(map, span.rawEnd, line.length + 1);
  let clippedBefore = false;
  let clippedAfter = false;
  const words = (s: string) => s.split(/(\s+)/);
  const b = words(before);
  if (b.filter((w) => w.trim()).length > windowWords) {
    let kept = 0;
    let i = b.length;
    while (i > 0 && kept < windowWords) kept += b[--i]!.trim() ? 1 : 0;
    before = b.slice(i).join("");
    clippedBefore = true;
  }
  const a = words(after);
  if (a.filter((w) => w.trim()).length > windowWords) {
    let kept = 0;
    let i = 0;
    while (i < a.length && kept < windowWords) kept += a[i++]!.trim() ? 1 : 0;
    after = a.slice(0, i).join("");
    clippedAfter = true;
  }
  return { before, match, after, clippedBefore, clippedAfter };
}
