import type { BookRef, Link, LinkSide } from "../core/links/model";

/*
 * Coverage of one book by links (issue #17: "which parts of the commentary are still unlinked?"), pure.
 *
 * Every line of the book falls in one bucket (the five the review lists show):
 *   not-suitable  a line that cannot carry a link: a heading (the generator drops a link to one, AGENTS.md §3) or a
 *                 line the caller says is blank or too short to be linked (CoverageBook.unsuitable)
 *   unlinked      a suitable line no link touches
 *   linked        the line starts exactly one link place (one link, or several to the same place)
 *   multiple      the line is covered by links to two or more different places
 *   partial       the line is covered only INSIDE a range that starts on an earlier line (line_index_N … _end): the
 *                 span reaches it, no link of its own starts there
 * A link's own line is its start; its range (`end`) covers the lines after it, as ranges.ts reads them. Only
 * live links count (a deleted link covers nothing). The links given are what the caller chose to count — the
 * project's links, and optionally the database's (CoverageBook is silent about which).
 *
 * "Unlinked ranges" are the consecutive unlinked lines, split by any other line: a heading, a linked line, a
 * blank one. Nothing here reads a book or changes state (state/coverage.ts feeds it).
 */

export type LineCoverage = "linked" | "unlinked" | "partial" | "multiple" | "not-suitable";

export interface CoverageBook {
  /** true for every link end that lies in this book (the store compares book keys/titles) */
  readonly owns: (ref: BookRef) => boolean;
  readonly lineCount: number;
  /** heading lines, 0-based */
  readonly headings: ReadonlySet<number>;
  /** lines that are not headings but cannot carry a link either (blank, a few letters): the caller knows the text */
  readonly unsuitable?: ReadonlySet<number>;
}

export interface LineRange {
  /** first line, 0-based */
  readonly start: number;
  /** last line, inclusive */
  readonly end: number;
}

const live = (l: Link) => l.status !== "deleted";
const placeKey = (s: LinkSide) => `${s.book.key}#${s.line}-${s.end ?? s.line}`;

/** The bucket of every line, by line index. A line outside [0, lineCount) has none. */
export function coverageOfLines(links: readonly Link[], book: CoverageBook): LineCoverage[] {
  const n = Math.max(0, book.lineCount);
  /** the place (index into `places`) the first covering link points to, -1 none */
  const first = new Int32Array(n).fill(-1);
  const several = new Uint8Array(n);
  const starts = new Uint8Array(n);
  const places = new Map<string, number>();
  const placeOf = (s: LinkSide): number => {
    const k = placeKey(s);
    let id = places.get(k);
    if (id === undefined) places.set(k, (id = places.size));
    return id;
  };
  const cover = (line: number, place: number, own: boolean) => {
    if (line < 0 || line >= n) return;
    if (own) starts[line] = 1;
    if (first[line] === -1) first[line] = place;
    else if (first[line] !== place) several[line] = 1;
  };
  for (const l of links) {
    if (!live(l)) continue;
    // each end that lies in this book covers its own lines; the place it stands for is the other end
    for (const [mine, other] of [[l.source, l.target], [l.target, l.source]] as const) {
      if (!book.owns(mine.book)) continue;
      const place = placeOf(other);
      cover(mine.line, place, true);
      const end = mine.end ?? mine.line;
      for (let i = mine.line + 1; i <= end && i < n; i++) cover(i, place, false);
    }
  }
  const out: LineCoverage[] = new Array<LineCoverage>(n);
  for (let i = 0; i < n; i++) {
    if (book.headings.has(i) || book.unsuitable?.has(i)) out[i] = "not-suitable";
    else if (first[i] === -1) out[i] = "unlinked";
    else if (several[i]) out[i] = "multiple";
    else out[i] = starts[i] ? "linked" : "partial";
  }
  return out;
}

/** Consecutive unlinked (suitable, untouched) lines, in book order. Every other line splits a range. */
export function unlinkedRanges(links: readonly Link[], book: CoverageBook): LineRange[] {
  return rangesOf(coverageOfLines(links, book));
}

export function rangesOf(coverage: readonly LineCoverage[]): LineRange[] {
  const out: LineRange[] = [];
  let start = -1;
  for (let i = 0; i <= coverage.length; i++) {
    const open = i < coverage.length && coverage[i] === "unlinked";
    if (open && start < 0) start = i;
    else if (!open && start >= 0) {
      out.push({ start, end: i - 1 });
      start = -1;
    }
  }
  return out;
}

export interface CoverageSummary {
  readonly total: number;
  readonly byBucket: Readonly<Record<LineCoverage, number>>;
  /** lines that could be linked (every bucket but not-suitable) */
  readonly suitable: number;
  /** suitable lines with no link at all, and the share they are of the suitable ones (0 when there are none) */
  readonly unlinked: number;
  readonly unlinkedShare: number;
  readonly ranges: readonly LineRange[];
}

export function coverageSummary(links: readonly Link[], book: CoverageBook): CoverageSummary {
  const coverage = coverageOfLines(links, book);
  const byBucket: Record<LineCoverage, number> = { linked: 0, unlinked: 0, partial: 0, multiple: 0, "not-suitable": 0 };
  for (const c of coverage) byBucket[c]++;
  const suitable = coverage.length - byBucket["not-suitable"];
  return { total: coverage.length, byBucket, suitable, unlinked: byBucket.unlinked, unlinkedShare: suitable ? byBucket.unlinked / suitable : 0, ranges: rangesOf(coverage) };
}
