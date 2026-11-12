/**
 * Visible ↔ raw character offsets inside a line of book HTML — an exact port of the generator's
 * rules, because the generator turns the raw `start`/`end` of a `_links.json` record into
 * `link_anchor.charStart/charEnd` with them:
 *   SeforimLibrary@23f1f8f1 generator/common/.../common/HtmlCharCounter.kt
 *   (`countVisibleChars(html, endExclusive)` and `visibleUnits(html)`).
 *
 *   • `<` opens a tag that lasts until the next `>`. A `<` with no `>` therefore hides the REST OF
 *     THE LINE (v3 counted it as a character — that disagreed with the generator).
 *   • `&` followed by `;` within the next 9 characters (entity of at most 10 chars) is ONE visible
 *     unit; otherwise the `&` alone is a unit and the following characters count normally.
 *     (v3 allowed 12 characters after `&`.)
 *   • Offsets are UTF-16 code units, as in Kotlin and JavaScript strings.
 */

const ENTITY_SPAN = 10;

/** One visible unit: a single character, or a whole `&…;` entity. `[start, end)` in raw offsets. */
export interface VisibleUnit {
  start: number;
  end: number;
}

/** The visible units of a line, in order (port of `visibleUnits`). */
export function visibleUnits(html: string): VisibleUnit[] {
  const s = String(html);
  const units: VisibleUnit[] = [];
  let inTag = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inTag) {
      if (c === ">") inTag = false;
    } else if (c === "<") {
      inTag = true;
    } else if (c === "&") {
      const end = Math.min(s.length, i + ENTITY_SPAN);
      let j = i + 1;
      while (j < end && s[j] !== ";") j++;
      if (j < end) {
        units.push({ start: i, end: j + 1 });
        i = j;
      } else {
        units.push({ start: i, end: i + 1 });
      }
    } else {
      units.push({ start: i, end: i + 1 });
    }
  }
  return units;
}

/**
 * Visible characters in `html[0, endExclusive)` — exact port of the generator's
 * `countVisibleChars`, including its behaviour when `endExclusive` falls inside an entity.
 */
export function countVisibleChars(html: string, endExclusive: number = String(html).length): number {
  const s = String(html);
  if (!s.length || endExclusive <= 0) return 0;
  const len = Math.min(s.length, endExclusive);
  let count = 0;
  let inTag = false;
  for (let i = 0; i < len; i++) {
    const c = s[i];
    if (inTag) {
      if (c === ">") inTag = false;
    } else if (c === "<") {
      inTag = true;
    } else if (c === "&") {
      const end = Math.min(len, i + ENTITY_SPAN);
      let j = i + 1;
      while (j < end && s[j] !== ";") j++;
      count++;
      if (j < end) i = j;
    } else {
      count++;
    }
  }
  return count;
}

/**
 * Raw offset where visible unit `visibleIndex` begins — i.e. the offset to write to `start`/`end`
 * so that the generator's `countVisibleChars(content, raw)` gives back exactly `visibleIndex`.
 * Opening tags before the glyph are skipped (the offset points at the glyph, not the tag), which
 * yields the documented example "אב <b>ג</b> דה": visible 3..5 → raw 6..12.
 * Past the last unit, returns the line length.
 */
export function rawOffsetFromVisible(html: string, visibleIndex: number): number {
  const s = String(html);
  const v = Math.trunc(Number(visibleIndex));
  const units = visibleUnits(s);
  if (!(v >= 0)) return 0;
  return v < units.length ? units[v]!.start : s.length;
}
