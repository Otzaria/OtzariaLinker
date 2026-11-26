import type { BookHeading } from "../books";
import { toGematria } from "../text/gematria";
import type { AltTocEntry } from "./model";

/*
 * Editing helpers of the alt_toc editor, carried over from version 3 (legacy/OtzariaLinker-v3.html,
 * `Dialogs.altToc`: "מילוי מכותרות הספר" and `numberInGematria`). Pure: each returns new entries.
 */

/**
 * The book's own headings as a starting point: one entry per heading line, the shallowest heading
 * level becoming level 0. The user then deletes or renames what the second division does not need.
 */
export function entriesFromHeadings(headings: readonly BookHeading[]): AltTocEntry[] {
  if (!headings.length) return [];
  const min = Math.min(...headings.map((h) => h.level));
  return headings.map((h) => ({ heTitle: h.text, line: h.line + 1, level: h.level - min }));
}

/**
 * Renames every entry below level 0 to "<base> <Hebrew numeral>" ("עליה א", "עליה ב"…), the way
 * Sefaria labels aliyot. The count restarts under every parent; level-0 entries keep their names.
 */
export function numberInGematria(entries: readonly AltTocEntry[], base: string): { entries: AltTocEntry[]; changed: number } {
  const word = base.trim();
  const counters: number[] = [];
  let changed = 0;
  const out = entries.map((e) => {
    const level = e.level > 0 ? Math.trunc(e.level) : 0;
    if (level === 0) {
      counters.length = 0;
      return e;
    }
    counters.length = level; // a shallower entry ends the deeper sequences
    counters[level - 1] = (counters[level - 1] ?? 0) + 1;
    changed++;
    return { ...e, heTitle: `${word} ${toGematria(counters[level - 1]!)}`.trim() };
  });
  return { entries: out, changed };
}

/** One node one place up (-1) or down (+1); at an edge the same array is returned. */
export function moveEntry(entries: readonly AltTocEntry[], i: number, delta: -1 | 1): readonly AltTocEntry[] {
  const j = i + delta;
  if (i < 0 || j < 0 || j >= entries.length) return entries;
  const out = [...entries];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** A new empty node right after node `i`, at its level and line (the user then names it). */
export function insertEntryAfter(entries: readonly AltTocEntry[], i: number): AltTocEntry[] {
  const at = entries[i];
  const out = [...entries];
  out.splice(i + 1, 0, { heTitle: "", line: at?.line ?? 1, level: at?.level ?? 0 });
  return out;
}

/** Node `i` and the nodes under it (the deeper ones that follow) one level in (+1) or out (-1); never below 0. */
export function shiftLevel(entries: readonly AltTocEntry[], i: number, delta: -1 | 1): readonly AltTocEntry[] {
  const at = entries[i];
  if (!at || at.level + delta < 0) return entries;
  let end = i + 1;
  while (end < entries.length && entries[end]!.level > at.level) end++;
  return entries.map((e, j) => (j >= i && j < end ? { ...e, level: e.level + delta } : e));
}
