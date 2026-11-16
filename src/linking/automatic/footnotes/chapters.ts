import { stripTags } from "../../../core/text/html";
import { normalize } from "../../../core/text/hebrew";
import type { EngineLine } from "../types";
import type { Marker } from "./markers";

/*
 * Chapters of the notes book and their alignment with the main book.
 *
 *   resetChapters  — port of Link-Notes splitNotesIntoChapters: a plain "1" (or "א") starts a new
 *                    chapter whenever the current one is not empty.
 *   headingSections / pairSections — the option REUSE_MATRIX §2.2 asked for ("every chapter has a
 *                    heading"): both books are cut at their heading lines and the pieces are paired
 *                    by the heading text, so the chapter of a marker is KNOWN instead of inferred.
 */

export interface Occ {
  readonly line: number;
  readonly marker: Marker;
}

export interface Chapter {
  /** 0-based, over the whole notes book */
  readonly no: number;
  readonly occs: readonly Occ[];
  readonly keyToLines: ReadonlyMap<string, readonly number[]>;
  readonly firstLine: number;
  readonly lastLine: number;
  /** a heading line of the notes book lies just before the chapter (between it and the previous one) */
  readonly afterHeading: boolean;
  /** heading text of the section this chapter belongs to (headings mode) */
  readonly label?: string;
}

export const isPlainKey = (key: string): boolean => /^\d+$/.test(key);

/**
 * Port of splitNotesIntoChapters (+ buildChapterInfo's key map): a plain 1 starts a new chapter.
 * Added: a number that already occurred in the current chapter AND is lower than the one before it
 * also starts one — real notes books restart at 2 or 3 when the first note of a chapter belongs
 * elsewhere (measured: שות רבי שלמה ברוך).
 */
export function resetChapters(occs: readonly Occ[], firstNo: number, headingBefore: (a: number, b: number) => boolean, label?: string, split = true): Chapter[] {
  const groups: Occ[][] = [];
  let current: Occ[] = [];
  let keys = new Set<string>();
  for (const occ of occs) {
    const prev = current.at(-1)?.marker;
    const restart = (occ.marker.num === 1 && isPlainKey(occ.marker.key)) || (keys.has(occ.marker.key) && !!prev && occ.marker.num < prev.num);
    if (split && current.length > 0 && restart) {
      groups.push(current);
      current = [occ];
      keys = new Set([occ.marker.key]);
    } else {
      current.push(occ);
      keys.add(occ.marker.key);
    }
  }
  if (current.length) groups.push(current);
  return groups.map((g, i) => {
    const keyToLines = new Map<string, number[]>();
    for (const o of g) {
      const list = keyToLines.get(o.marker.key) ?? [];
      if (!list.includes(o.line)) list.push(o.line);
      keyToLines.set(o.marker.key, list);
    }
    const prevLast = i > 0 ? groups[i - 1]!.at(-1)!.line : -1;
    return {
      no: firstNo + i,
      occs: g,
      keyToLines,
      firstLine: g[0]!.line,
      lastLine: g.at(-1)!.line,
      afterHeading: headingBefore(prevLast, g[0]!.line),
      ...(label !== undefined ? { label } : {}),
    };
  });
}

/** Prefix counts of heading lines: is there a heading strictly between lines a and b? */
export function headingCounter(lines: readonly EngineLine[]): (a: number, b: number) => boolean {
  const prefix = new Int32Array(lines.length + 1);
  for (let i = 0; i < lines.length; i++) prefix[i + 1] = prefix[i]! + (lines[i]!.heading !== null ? 1 : 0);
  const at = (i: number) => prefix[Math.max(0, Math.min(lines.length, i))]!;
  return (a, b) => at(b) - at(a + 1) > 0;
}

export interface Section {
  readonly id: number;
  readonly startLine: number;
  /** normalized heading texts from level 2 down to the heading that opened the section */
  readonly path: readonly string[];
  /** display text of the opening heading */
  readonly title: string;
}

/**
 * Cuts a book at its heading lines (only levels ≤ `level` when given). Level-1 headings are left
 * out of the path: they carry the book's own title, which differs between a book and its notes.
 */
export function headingSections(lines: readonly EngineLine[], level?: number): { sectionOf: Int32Array; sections: Section[] } {
  const sectionOf = new Int32Array(lines.length);
  const sections: Section[] = [{ id: 0, startLine: 0, path: [], title: "" }];
  const stack: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i]!.heading;
    if (h !== null) {
      const text = stripTags(lines[i]!.text);
      stack.length = h - 1;
      stack[h - 1] = text;
      if (level === undefined || h <= level) {
        const path = stack.slice(1).filter((x) => x !== undefined).map((x) => normalize(x));
        sections.push({ id: sections.length, startLine: i, path, title: text });
      }
    }
    sectionOf[i] = sections.length - 1;
  }
  return { sectionOf, sections };
}

/**
 * Pairs each notes section with the main section of the same heading: first by the whole heading
 * path, then by the last heading text when it is unique on both sides. One main section serves
 * one notes section.
 */
export function pairSections(main: readonly Section[], notes: readonly Section[]): Map<number, number> {
  const out = new Map<number, number>();
  const used = new Set<number>();
  const byPath = groupBy(main, (s) => s.path.join(" / "));
  const byLast = groupBy(main, (s) => s.path.at(-1) ?? "");
  const notesByLast = groupBy(notes, (s) => s.path.at(-1) ?? "");
  for (const n of notes) {
    if (!n.path.length) continue;
    let m = byPath.get(n.path.join(" / "));
    if (!m || m.length !== 1) {
      const last = n.path.at(-1)!;
      m = notesByLast.get(last)?.length === 1 ? byLast.get(last) : undefined;
    }
    if (m && m.length === 1 && !used.has(m[0]!.id)) {
      out.set(n.id, m[0]!.id);
      used.add(m[0]!.id);
    }
  }
  return out;
}

function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!k) continue;
    const list = m.get(k) ?? [];
    list.push(x);
    m.set(k, list);
  }
  return m;
}
