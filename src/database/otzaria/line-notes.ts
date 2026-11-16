/*
 * Schema 7 moves footnote bodies out of the line into line_note(lineId, noteIndex, charPos,
 * hasMarker, body). link_anchor offsets of such a line count the FULL line — with every body put
 * back at its charPos. This is an exact port of the generator's reconstruction:
 *   SeforimLibrary@23f1f8f1 generator/common/.../common/notes/LineNoteRehydration.kt (rehydrate)
 *   and InlineNotes.markerRanges (the footnote-marker <sup> regex).
 * Without it, anchors on lines that have notes land on the wrong words.
 */
export interface NoteAt {
  /** visible offset in the stored line (countVisibleChars convention) */
  charPos: number;
  body: string;
  hasMarker: boolean;
}

const OPEN = '<i class="footnote">';
const CLOSE = "</i>";
const SUP = /<sup\b[^>]*>.*?<\/sup>/gis;
const MARKER = /<sup\b[^>]*\bclass\s*=\s*"footnote-marker"[^>]*>(.*?)<\/sup>/gis;
const INLINE_CLOSE =
  /<\/(?:b|i|em|strong|u|s|strike|span|sup|sub|small|big|font|del|ins|a|abbr|acronym|cite|code|dfn|kbd|q|samp|tt|var|mark|bdi|bdo|ruby|rt|rp)\s*>/iy;
const ENTITY_SPAN = 10;

/** [first, last] — inclusive, like Kotlin's IntRange */
type Range = readonly [number, number];
const rangesOf = (re: RegExp, s: string): Range[] => [...s.matchAll(re)].map((m) => [m.index, m.index + m[0].length - 1] as const);

/** `notes` in noteIndex order (charPos never decreases along it). */
export function rehydrateLine(stored: string, notes: readonly NoteAt[]): string {
  if (!notes.length) return stored;
  const sups = rangesOf(SUP, stored);
  const markers = notes.some((n) => n.hasMarker) ? rangesOf(MARKER, stored) : [];
  let anchoredSeen = 0;
  let cursor = 0;
  let out = "";
  for (const note of notes) {
    let at = insertionPoint(stored, note.charPos, sups);
    if (note.hasMarker) {
      const marker = markers[anchoredSeen++];
      if (marker && at <= marker[0] && onlyTagsBetween(stored, at, marker[0])) at = afterInlineClosings(stored, marker[1] + 1);
    }
    at = Math.max(at, cursor);
    out += stored.slice(cursor, at) + OPEN + note.body + CLOSE;
    cursor = at;
  }
  return out + stored.slice(cursor);
}

function afterInlineClosings(html: string, from: number): number {
  let at = from;
  while (at < html.length) {
    INLINE_CLOSE.lastIndex = at;
    const m = INLINE_CLOSE.exec(html);
    if (!m) break;
    at = m.index + m[0].length;
  }
  return at;
}

/** Opening markup before an empty marker contributes no visible offset. No gaps are skipped. */
function onlyTagsBetween(html: string, from: number, end: number): boolean {
  let at = from;
  while (at < end) {
    if (html[at] !== "<") return false;
    const close = html.indexOf(">", at + 1);
    if (close < 0 || close >= end) return false;
    at = close + 1;
  }
  return at === end;
}

/** Raw offset just after the charPos-th visible char, past its marker's </sup> and adjacent inline closings. */
function insertionPoint(html: string, charPos: number, sups: readonly Range[]): number {
  let i = 0;
  if (charPos > 0) {
    let count = 0;
    let inTag = false;
    while (i < html.length && count < charPos) {
      const c = html[i];
      if (inTag) {
        if (c === ">") inTag = false;
      } else if (c === "<") {
        inTag = true;
      } else if (c === "&") {
        const end = Math.min(html.length, i + ENTITY_SPAN);
        let j = i + 1;
        while (j < end && html[j] !== ";") j++;
        count++;
        if (j < end) i = j;
      } else {
        count++;
      }
      i++;
    }
  }
  const marker = sups.find(([first, last]) => i > first && i <= last);
  if (marker) i = marker[1] + 1;
  return afterInlineClosings(html, i);
}
