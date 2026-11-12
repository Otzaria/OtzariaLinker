import type { BookRef, Link, LinkSide } from "../core/links/model";

/*
 * Range rules (v3 "Ranges", FEATURE_INVENTORY F-054/F-055/F-064/F-079/F-084/F-105), pure. A link's
 * range is stored as its END line only (`line_index_X_end`); the start is the link's own line.
 *
 * The rule users asked for: a range runs from its line to ONE LINE BEFORE THE NEXT MARKER, where a
 * marker is a line that already starts a link on that side, or a heading line; the last range runs to
 * the end of the book. A heading is never a valid range end (Otzaria drops such a range,
 * export/range-end-heading), so an end that falls on one steps back to the line before it.
 *
 * Everything here works on what the caller gives it: the links, which of them belong to the book, the
 * book's length and its heading lines. Nothing here reads a book or changes state; the store turns the
 * returned edits into one undoable history step.
 */

export type RangeSide = "source" | "target";

/** What a book contributes: its length and its heading lines (0-based, sorted or not). */
export interface RangeBook {
  /** true for every link end that lies in this book (the store compares book keys/titles) */
  readonly owns: (ref: BookRef) => boolean;
  readonly lineCount: number;
  readonly headings: ReadonlySet<number>;
}

/** v3's `rangeEndBasis`: what counts as "the next marker". */
export type MarkerBasis = "auto" | "links" | "headings" | "book";

/** One range change: the link and its side's new end (undefined = no range). */
export interface RangeEdit {
  readonly link: Link;
  readonly side: RangeSide;
  readonly before: number | undefined;
  readonly after: number | undefined;
}

const sideOf = (l: Link, side: RangeSide): LinkSide => (side === "source" ? l.source : l.target);
const live = (l: Link) => l.status !== "deleted";

/** Sorted marker lines of a book on one side (v3 `Ranges.markers`); `exclude` is a link id to ignore. */
export function rangeMarkers(links: Iterable<Link>, book: RangeBook, side: RangeSide, basis: MarkerBasis = "auto", exclude?: string): number[] {
  if (basis === "book") return [];
  const set = new Set<number>();
  if (basis === "auto" || basis === "links")
    for (const l of links) {
      if (!live(l) || l.id === exclude) continue;
      const s = sideOf(l, side);
      if (book.owns(s.book)) set.add(s.line);
    }
  if (basis === "auto" || basis === "headings") for (const h of book.headings) set.add(h);
  return [...set].sort((a, b) => a - b);
}

/** The first marker after `start` (binary search over sorted markers), or null. */
function nextAfter(sorted: readonly number[], start: number): number | null {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= start) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length ? sorted[lo]! : null;
}

/** Steps back from a heading line; never below `start`. */
function backFromHeading(end: number, start: number, headings: ReadonlySet<number>): number {
  let e = end;
  while (e > start && headings.has(e)) e--;
  return e;
}

/**
 * The suggested end of a range that starts at `start` (v3 `suggestEnd`): one line before the next
 * marker, else the last line of the book; never before `start`. Equal to `start` = no range.
 */
export function suggestEnd(start: number, markers: readonly number[], book: Pick<RangeBook, "lineCount" | "headings">): number {
  if (book.lineCount <= 0) return start;
  const next = nextAfter(markers, start);
  const end = next !== null ? next - 1 : book.lineCount - 1;
  return Math.max(start, backFromHeading(end, start, book.headings));
}

/**
 * Ranges that would swallow a new link starting at `newStart` are cut to end just before it
 * (v3 `trimPrevious`): only ranges of this book and side that start BEFORE the new line and reach it.
 */
export function trimBefore(links: Iterable<Link>, book: RangeBook, side: RangeSide, newStart: number, exclude?: string): RangeEdit[] {
  const out: RangeEdit[] = [];
  for (const l of links) {
    if (!live(l) || l.id === exclude || l.provenance === "db") continue;
    const s = sideOf(l, side);
    if (!book.owns(s.book) || s.end === undefined || s.line >= newStart || s.end < newStart) continue;
    const after = newStart - 1 > s.line ? newStart - 1 : undefined;
    out.push({ link: l, side, before: s.end, after });
  }
  return out;
}

export interface FillOptions {
  /** true (default, as in v3): only links that already have a range on this side; false: every link */
  readonly onlyRanged?: boolean;
}

/**
 * Range completion (v3 `autoFillBook`): every link of the book on this side gets the range "until one
 * line before the next link's start", the last until the end of the book; a heading end steps back.
 * Only real changes are returned. A book whose length is unknown (a "shadow" book that came from a
 * links file, with no text) is never touched: the ranges imported with it could only be lost.
 */
export function fillRanges(links: Iterable<Link>, book: RangeBook, side: RangeSide, options: FillOptions = {}): { edits: RangeEdit[]; skippedNoText: boolean } {
  if (book.lineCount <= 0) return { edits: [], skippedNoText: true };
  const onlyRanged = options.onlyRanged !== false;
  const mine = [...links].filter((l) => live(l) && l.provenance !== "db" && book.owns(sideOf(l, side).book));
  const starts = [...new Set(mine.map((l) => sideOf(l, side).line))].sort((a, b) => a - b);
  const edits: RangeEdit[] = [];
  for (const l of mine) {
    const s = sideOf(l, side);
    if (onlyRanged && s.end === undefined) continue;
    const next = nextAfter(starts, s.line);
    const want = backFromHeading(next !== null ? next - 1 : book.lineCount - 1, s.line, book.headings);
    if (want <= s.line || want === s.end) continue;
    edits.push({ link: l, side, before: s.end, after: want });
  }
  return { edits, skippedNoText: false };
}

/** The link after an edit: the side's end set (or removed), an existing link marked edited. */
export function applyRangeEdit(l: Link, side: RangeSide, end: number | undefined): Link {
  const cur = sideOf(l, side);
  const { end: _drop, ...rest } = cur;
  const next: LinkSide = end !== undefined && end > cur.line ? { ...rest, end } : rest;
  return { ...l, [side]: next, status: l.status === "existing" ? "edited" : l.status };
}
