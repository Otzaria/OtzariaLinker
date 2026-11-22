import type { BookRef, Link, LinkSide } from "../core/links/model";
import type { Suggestion } from "./automatic/types";
import type { QaIssue } from "./qa";

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

/**
 * The longest book coverage will count: a line count comes from a database (or a project file) and is allocated per line, so a
 * file that says a billion lines must not freeze the tab. Real books are far below this (the longest in v52 is under 200k lines).
 * Over it, the summary says `tooLarge` and counts nothing.
 */
export const MAX_BOOK_LINES = 5_000_000;

export type LineCoverage = "linked" | "unlinked" | "partial" | "multiple" | "not-suitable" | "candidate" | "doubtful";

export interface CoverageBook {
  /** true for every link end that lies in this book (the store compares book keys/titles) */
  readonly owns: (ref: BookRef) => boolean;
  readonly lineCount: number;
  /** heading lines, 0-based */
  readonly headings: ReadonlySet<number>;
  /** lines that are not headings but cannot carry a link either (blank, a few letters): the caller knows the text */
  readonly unsuitable?: ReadonlySet<number>;
  /** lines a pending suggestion points at (candidateLines): found by an engine, not approved yet */
  readonly candidates?: ReadonlySet<number>;
  /** lines of a link the QA flags (doubtfulLines) */
  readonly doubtful?: ReadonlySet<number>;
}

export interface LineRange {
  /** first line, 0-based */
  readonly start: number;
  /** last line, inclusive */
  readonly end: number;
}

const live = (l: Link) => l.status !== "deleted";
// the book's TITLE, not its key: the same place reached by a project link and by the database's link may spell the key of
// a book differently (session keys, imported files), and one place must not become two ("multiple")
const placeKey = (s: LinkSide) => `${s.book.title}#${s.line}-${s.end ?? s.line}`;

const BUCKETS: readonly LineCoverage[] = ["linked", "unlinked", "partial", "multiple", "not-suitable", "candidate", "doubtful"];
const [LINKED, UNLINKED, PARTIAL, MULTIPLE, NOT_SUITABLE, CANDIDATE, DOUBTFUL] = [0, 1, 2, 3, 4, 5, 6];

/** The bucket of every line as an index into BUCKETS (a byte per line: a book of millions of lines costs megabytes). */
function bucketCodes(links: readonly Link[], book: CoverageBook): Uint8Array {
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
      // a range reaches at most the book's last line, so a hostile `end` is not a loop
      for (let i = mine.line + 1; i <= end && i < n; i++) cover(i, place, false);
    }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (book.headings.has(i) || book.unsuitable?.has(i)) out[i] = NOT_SUITABLE;
    else if (first[i] === -1) out[i] = book.candidates?.has(i) ? CANDIDATE : UNLINKED;
    else if (book.doubtful?.has(i)) out[i] = DOUBTFUL;
    else if (several[i]) out[i] = MULTIPLE;
    else out[i] = starts[i] ? LINKED : PARTIAL;
  }
  return out;
}

/** True when the book is longer than coverage counts (MAX_BOOK_LINES); the summary then says so instead of allocating. */
export const tooLarge = (book: CoverageBook): boolean => !(book.lineCount <= MAX_BOOK_LINES);

/** The bucket of every line, by line index. A line outside [0, lineCount) has none. Throws RangeError over MAX_BOOK_LINES. */
export function coverageOfLines(links: readonly Link[], book: CoverageBook): LineCoverage[] {
  if (tooLarge(book)) throw new RangeError(`coverage of ${book.lineCount} lines (more than ${MAX_BOOK_LINES})`);
  return Array.from(bucketCodes(links, book), (c) => BUCKETS[c]!);
}

/** Consecutive unlinked (suitable, untouched) lines, in book order. Every other line splits a range. */
export function unlinkedRanges(links: readonly Link[], book: CoverageBook): LineRange[] {
  return tooLarge(book) ? [] : rangesOfCodes(bucketCodes(links, book));
}

export function rangesOf(coverage: readonly LineCoverage[]): LineRange[] {
  return rangesOfCodes(Uint8Array.from(coverage, (c) => BUCKETS.indexOf(c)));
}

function rangesOfCodes(coverage: Uint8Array): LineRange[] {
  const out: LineRange[] = [];
  let start = -1;
  for (let i = 0; i <= coverage.length; i++) {
    const open = i < coverage.length && coverage[i] === UNLINKED;
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
  /** the book is longer than MAX_BOOK_LINES: nothing was counted (total is its reported length, every bucket 0, no ranges) */
  readonly tooLarge?: true;
}

const TOO_LARGE = (total: number): Omit<CoverageSummary, "ranges"> => ({
  total,
  byBucket: { linked: 0, unlinked: 0, partial: 0, multiple: 0, "not-suitable": 0, candidate: 0, doubtful: 0 },
  suitable: 0,
  unlinked: 0,
  unlinkedShare: 0,
  tooLarge: true,
});

export function coverageSummary(links: readonly Link[], book: CoverageBook): CoverageSummary {
  if (tooLarge(book)) return { ...TOO_LARGE(book.lineCount), ranges: [] };
  const codes = bucketCodes(links, book);
  return { ...countsOf(codes), ranges: rangesOfCodes(codes) };
}

/** The table row of a book: the summary without the ranges (a table of thousands of books keeps no list per book). */
export function coverageCounts(links: readonly Link[], book: CoverageBook): Omit<CoverageSummary, "ranges"> {
  return tooLarge(book) ? TOO_LARGE(book.lineCount) : countsOf(bucketCodes(links, book));
}

function countsOf(coverage: Uint8Array): Omit<CoverageSummary, "ranges"> {
  const byBucket: Record<LineCoverage, number> = { linked: 0, unlinked: 0, partial: 0, multiple: 0, "not-suitable": 0, candidate: 0, doubtful: 0 };
  for (const c of coverage) byBucket[BUCKETS[c]!]++;
  const suitable = coverage.length - byBucket["not-suitable"];
  return { total: coverage.length, byBucket, suitable, unlinked: byBucket.unlinked, unlinkedShare: suitable ? byBucket.unlinked / suitable : 0 };
}

/**
 * The lines of ONE book that pending suggestions point at: both ends that lie in it (`owns`), a range whole; a suggestion
 * the caller calls decided (`pending` false: approved, rejected) and one with no confidence ("none") count for nothing.
 */
export function candidateLines(suggestions: readonly Suggestion[], pending: (id: string) => boolean, owns: (ref: BookRef) => boolean, lineCount: number = MAX_BOOK_LINES): Set<number> {
  const out = new Set<number>();
  for (const s of suggestions) {
    if (s.confidence === "none" || !pending(s.id)) continue;
    for (const side of [s.source, s.target]) if (owns(side.book)) addClamped(out, side, lineCount);
  }
  return out;
}

/** The lines of a side inside [0, lineCount): a range end read from a file is not a bound on a loop. */
function addClamped(out: Set<number>, side: LinkSide, lineCount: number): void {
  const last = Math.min(side.end ?? side.line, lineCount - 1, MAX_BOOK_LINES - 1);
  for (let i = Math.max(side.line, 0); i <= last; i++) out.add(i);
}

/** Categories the QA reports that say nothing about whether a link is right: where it already exists, a file to load, a line not read. */
const ADMINISTRATIVE: ReadonlySet<string> = new Set(["in-db", "db-copy", "library-file", "unverified", "edition"]);

/**
 * The lines of ONE book whose link the QA doubts: its errors and warnings, except the administrative categories
 * (ADMINISTRATIVE) and plain information. A range counts whole, up to the book's last line.
 */
export function doubtfulLines(issues: readonly QaIssue[], owns: (ref: BookRef) => boolean, lineCount: number = MAX_BOOK_LINES): Set<number> {
  const out = new Set<number>();
  for (const { link, category, problem } of issues) {
    if (problem.severity === "info" || ADMINISTRATIVE.has(category)) continue;
    for (const side of [link.source, link.target]) if (owns(side.book)) addClamped(out, side, lineCount);
  }
  return out;
}

