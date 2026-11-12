import { visibleUnits } from "./offsets";

/*
 * The VISIBLE text of a stored line, for matching: one character per visible unit of the generator
 * (offsets.ts — tags hidden, an entity is one unit), with every unit's raw span. A match found in
 * `text` at [i, j) maps back to the raw anchor [starts[i], ends[j - 1]) that the generator turns into
 * exactly the same visible characters. Used by every engine that searches line text and anchors
 * what it found (footnote markers, user patterns).
 */

/** The visible text of a line, one character per visible unit, with each unit's raw span. */
export interface VisibleMap {
  readonly text: string;
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

const ENTITY_CHARS: Readonly<Record<string, string>> = { "&quot;": '"', "&amp;": "&", "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&apos;": "'" };

export function visibleMap(html: string): VisibleMap {
  const units = visibleUnits(html);
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const u of units) {
    const raw = html.slice(u.start, u.end);
    // an entity is ONE unit; its stand-in character must also be one UTF-16 unit
    text += raw.length === 1 ? raw : ENTITY_CHARS[raw.toLowerCase()] ?? "￼";
    starts.push(u.start);
    ends.push(u.end);
  }
  return { text, starts, ends };
}

/** Index of the first visible unit at or after raw offset `raw`. */
export function unitAt(map: VisibleMap, raw: number): number {
  let lo = 0;
  let hi = map.starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map.starts[mid]! < raw) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The visible text between two raw offsets. */
export function visibleBetween(map: VisibleMap, rawStart: number, rawEnd: number): string {
  return map.text.slice(unitAt(map, rawStart), unitAt(map, rawEnd));
}
