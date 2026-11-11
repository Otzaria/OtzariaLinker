/**
 * Visible ↔ raw character offsets inside a line of book HTML.
 *
 * The user selects on rendered text (no tags); the link file needs RAW offsets (tags included).
 * Rules match the generator's `buildLinkAnchor`:
 *   • a tag `<…>` is swallowed and does not count as a visible character;
 *   • an entity `&…;` counts as ONE visible character;
 *   • a lone `<` without `>` or `&` without `;` is plain text — otherwise the scanner runs to the
 *     end of the string and returns an offset past it, and the generator rejects the anchor.
 * Verified example from the format doc: "אב <b>ג</b> דה", visible 3..5 → raw 6..12.
 */

/** An entity longer than this is not an entity. */
const ENTITY_MAX = 12;

function tagEnd(s: string, i: number): number | null {
  const gt = s.indexOf(">", i);
  return gt === -1 ? null : gt + 1;
}

function entityEnd(s: string, i: number): number | null {
  const sc = s.indexOf(";", i);
  return sc === -1 || sc - i > ENTITY_MAX ? null : sc + 1;
}

/** Advances one visible unit from `raw`; returns the new raw index and how many visible chars were consumed. */
function step(s: string, raw: number): [next: number, visible: 0 | 1] {
  const ch = s[raw];
  if (ch === "<") {
    const e = tagEnd(s, raw);
    return e == null ? [raw + 1, 1] : [e, 0];
  }
  if (ch === "&") {
    const e = entityEnd(s, raw);
    return [e ?? raw + 1, 1];
  }
  return [raw + 1, 1];
}

export function rawOffsetFromVisible(rawHtml: string, visibleIndex: number): number {
  const s = String(rawHtml);
  const n = s.length;
  let raw = 0;
  let visible = 0;
  while (visible < visibleIndex && raw < n) {
    const [next, v] = step(s, raw);
    raw = next;
    visible += v;
  }
  // Snap onto the glyph itself: skip opening tags that precede it, so the offset points at the
  // character and not at the tag boundary (this is what yields start=6 in the documented example).
  while (raw < n && s[raw] === "<") {
    const e = tagEnd(s, raw);
    if (e == null) break;
    raw = e;
  }
  return Math.min(raw, n);
}

/** The inverse: how many visible characters precede a raw offset. */
export function countVisibleChars(rawHtml: string, rawIndex: number): number {
  const s = String(rawHtml);
  const lim = Math.min(rawIndex, s.length);
  let raw = 0;
  let visible = 0;
  while (raw < lim) {
    const [next, v] = step(s, raw);
    raw = next;
    visible += v;
  }
  return visible;
}
