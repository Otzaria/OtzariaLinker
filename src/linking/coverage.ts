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
 * What the words mean (fix round before the merge of PR 2; docs/AUTOMATION_ENGINE.md §5.8):
 *   PLACE      the lines a link points to in another book. The same lines are ONE place however many links say so (a doubled
 *              bidirectional link, two anchors of one relation, two link types), and spans in the same book that overlap or nest are one
 *              place too (the library's link to a whole siman and a line inside it: the second refines the first, it is not another target).
 *   multiple   the line is linked to at least two different PLACES (another book, or lines that do not overlap).
 *   partial    the line is not fully linked although something touches it: it holds several content units (CoverageBook.units: how many
 *              quotations, notes or citations the line carries, as far as the caller knows) of which fewer have a link of their own, or it is
 *              reached only by a range that starts on an earlier line. A line with one unit and a link of its own is "linked", never "partial".
 *   Precedence when a line fits more than one: not-suitable, then unlinked/candidate (nothing touches it), doubtful, multiple, partial, linked.
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
  /** how many content units a line holds, only where more than one (contentUnits); a line not in the map has one */
  readonly units?: ReadonlyMap<number, number>;
}

/**
 * What the count knows about the DATABASE's own links of the book. Three answers that must never look alike:
 *   none      the read succeeded and the book has no links there ("no links")
 *   unknown   the links were not read, so the counts say nothing about them ("coverage unknown"): not asked for, or nothing was read
 *   failed    the read was tried and failed ("read failed"): the counts are NOT "no links"
 * and `counted` when the read succeeded and found some. The screens read this before they show a zero.
 */
export type LinksReading =
  | { readonly state: "counted"; readonly count: number }
  | { readonly state: "none" }
  | { readonly state: "unknown"; readonly why: "not-requested" | "not-read" }
  /** some of the book's links are in a table its database cannot read (SourceBook.linksUnread, db/user-link-not-read): what was read is not all */
  | { readonly state: "unknown"; readonly why: "unreadable"; readonly message: string }
  | { readonly state: "failed"; readonly message: string };

/** The sentence a screen shows for a reading: a failed read never reads like "no links". */
export function linksReadingText(r: LinksReading): string {
  switch (r.state) {
    case "counted":
      return `נקראו ${r.count.toLocaleString("he")} קישורים של הספר מהמסד, והם נספרו.`;
    case "none":
      return "נקראו הקישורים של הספר מהמסד: אין לו קישורים שם.";
    case "unknown":
      if (r.why === "unreadable") return `חלק מהקישורים של הספר במסד לא נקראו, ולכן לא ידוע כמה שורות מקושרות (זה אינו "אין קישורים"). ${r.message}`;
      return r.why === "not-requested"
        ? "הקישורים שבמסד לא נספרו (נספרו רק קישורי הפרויקט), ולכן לא ידוע כמה שורות כבר מקושרות שם."
        : "הקישורים של הספר לא נקראו, ולכן לא ידוע כמה שורות מקושרות.";
    case "failed":
      return `קריאת הקישורים של הספר מהמסד נכשלה: ${r.message}. הקישורים שבמסד לא נקראו, ולכן המספרים כאן אינם אומרים שאין לספר קישורים. נסו שוב.`;
  }
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

interface PlaceSpan {
  readonly book: string;
  readonly start: number;
  readonly end: number;
}
const spanOf = (s: LinkSide): PlaceSpan => ({ book: s.book.title, start: s.line, end: Math.max(s.line, s.end ?? s.line) });

/** How many different PLACES a set of spans is: spans of one book that overlap (share a line) are one place, transitively. */
function placeCount(spans: readonly PlaceSpan[]): number {
  const byBook = new Map<string, PlaceSpan[]>();
  for (const sp of spans) {
    const list = byBook.get(sp.book);
    if (list) list.push(sp);
    else byBook.set(sp.book, [sp]);
  }
  let count = 0;
  for (const list of byBook.values()) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    let reach = -1;
    for (const sp of list) {
      if (sp.start > reach) count++;
      reach = Math.max(reach, sp.end);
    }
  }
  return count;
}

/** One link (or suggestion) as a content unit of a line: the anchor's start when it has one on this line, else the place it points to. */
interface UnitEntry {
  readonly anchor: number | null;
  readonly place: PlaceSpan;
}

/** The content units of a line that the entries stand for: distinct anchors, plus the places of the entries with no anchor. */
function unitCount(entries: readonly UnitEntry[]): number {
  const anchors = new Set<number>();
  const bare: PlaceSpan[] = [];
  for (const e of entries) {
    if (e.anchor !== null) anchors.add(e.anchor);
    else bare.push(e.place);
  }
  return anchors.size + placeCount(bare);
}

const BUCKETS: readonly LineCoverage[] = ["linked", "unlinked", "partial", "multiple", "not-suitable", "candidate", "doubtful"];
const [LINKED, UNLINKED, PARTIAL, MULTIPLE, NOT_SUITABLE, CANDIDATE, DOUBTFUL] = [0, 1, 2, 3, 4, 5, 6];

/** The bucket of every line as an index into BUCKETS (a byte per line: a book of millions of lines costs megabytes). */
function bucketCodes(links: readonly Link[], book: CoverageBook): Uint8Array {
  const n = Math.max(0, book.lineCount);
  /** the place (index into `places`) the first covering link points to, -1 none */
  const first = new Int32Array(n).fill(-1);
  const starts = new Uint8Array(n);
  const places = new Map<string, number>();
  const spans: PlaceSpan[] = [];
  const placeOf = (s: LinkSide): number => {
    const k = placeKey(s);
    let id = places.get(k);
    if (id === undefined) {
      id = places.size;
      places.set(k, id);
      spans.push(spanOf(s));
    }
    return id;
  };
  /** lines reached by two or more different place keys, by line, with those keys (they may still be one place: see placeCount) */
  const several = new Map<number, Set<number>>();
  /** the own links of the lines the caller says hold several units (only those lines are tracked) */
  const unitEntries = new Map<number, UnitEntry[]>();
  const cover = (line: number, place: number, own: boolean) => {
    if (line < 0 || line >= n) return;
    if (own) starts[line] = 1;
    if (first[line] === -1) first[line] = place;
    else if (first[line] !== place) {
      const set = several.get(line);
      if (set) set.add(place);
      else several.set(line, new Set([first[line]!, place]));
    }
  };
  for (const l of links) {
    if (!live(l)) continue;
    // each end that lies in this book covers its own lines; the place it stands for is the other end
    for (const [mine, other] of [[l.source, l.target], [l.target, l.source]] as const) {
      if (!book.owns(mine.book)) continue;
      const place = placeOf(other);
      cover(mine.line, place, true);
      if (book.units && (book.units.get(mine.line) ?? 1) > 1 && mine.line >= 0 && mine.line < n) {
        const entry: UnitEntry = { anchor: mine === l.source && l.anchor ? l.anchor.rawStart : null, place: spans[place]! };
        const list = unitEntries.get(mine.line);
        if (list) list.push(entry);
        else unitEntries.set(mine.line, [entry]);
      }
      const end = mine.end ?? mine.line;
      // a range reaches at most the book's last line, so a hostile `end` is not a loop
      for (let i = mine.line + 1; i <= end && i < n; i++) cover(i, place, false);
    }
  }
  // a line with two place KEYS is "multiple" only when they are two different PLACES (a coarse span and a line inside it are one)
  const differentPlaces = new Set<number>();
  for (const [line, ids] of several) if (placeCount([...ids].map((id) => spans[id]!)) > 1) differentPlaces.add(line);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (book.headings.has(i) || book.unsuitable?.has(i)) out[i] = NOT_SUITABLE;
    else if (first[i] === -1) out[i] = book.candidates?.has(i) ? CANDIDATE : UNLINKED;
    else if (book.doubtful?.has(i)) out[i] = DOUBTFUL;
    else if (differentPlaces.has(i)) out[i] = MULTIPLE;
    else if (!starts[i]) out[i] = PARTIAL;
    else {
      // its own link, but a line of several units is linked only when each unit has a link of its own
      const entries = unitEntries.get(i);
      out[i] = entries && unitCount(entries) < book.units!.get(i)! ? PARTIAL : LINKED;
    }
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
  /**
   * What is known about the database's links (LinksReading). The pure functions below count the links they are GIVEN and say nothing
   * about where they came from, so it is absent unless the caller passes it; the state (state/coverage.ts) always does (CoverageReport).
   */
  readonly links?: LinksReading;
}

const TOO_LARGE = (total: number): Omit<CoverageSummary, "ranges"> => ({
  total,
  byBucket: { linked: 0, unlinked: 0, partial: 0, multiple: 0, "not-suitable": 0, candidate: 0, doubtful: 0 },
  suitable: 0,
  unlinked: 0,
  unlinkedShare: 0,
  tooLarge: true,
});

export function coverageSummary(links: readonly Link[], book: CoverageBook, reading?: LinksReading): CoverageSummary {
  const extra = reading ? { links: reading } : {};
  if (tooLarge(book)) return { ...TOO_LARGE(book.lineCount), ...extra, ranges: [] };
  const codes = bucketCodes(links, book);
  return { ...countsOf(codes), ...extra, ranges: rangesOfCodes(codes) };
}

/** The table row of a book: the summary without the ranges (a table of thousands of books keeps no list per book). */
export function coverageCounts(links: readonly Link[], book: CoverageBook, reading?: LinksReading): Omit<CoverageSummary, "ranges"> {
  const extra = reading ? { links: reading } : {};
  return tooLarge(book) ? { ...TOO_LARGE(book.lineCount), ...extra } : { ...countsOf(bucketCodes(links, book)), ...extra };
}

/**
 * The result the state gives (state/coverage.ts `summary`): a CoverageSummary whose `links` is always there. Read `links` BEFORE showing a
 * count: with `failed` or `unknown` the buckets cover only the project's links (and what the book's own text says), and a bucket that
 * says "unlinked" is not a statement about the database.
 */
export type CoverageReport = CoverageSummary & { readonly links: LinksReading };

/**
 * How many content units each line holds, only where more than one (CoverageBook.units): the distinct units of the live links that start on
 * a line of the book (`owns`), plus those of the pending suggestions (`pending`), a unit being the anchor's start when the record has one on
 * that line, else the place it points to. A unit with a link and the same unit in a pending suggestion are one.
 */
export function contentUnits(links: readonly Link[], suggestions: readonly Suggestion[], pending: (id: string) => boolean, owns: (ref: BookRef) => boolean, lineCount: number): Map<number, number> {
  const byLine = new Map<number, UnitEntry[]>();
  const add = (mine: LinkSide, other: LinkSide, anchorOwner: boolean, anchor: { rawStart: number } | undefined) => {
    if (mine.line < 0 || mine.line >= lineCount) return;
    const entry: UnitEntry = { anchor: anchorOwner && anchor ? anchor.rawStart : null, place: spanOf(other) };
    const list = byLine.get(mine.line);
    if (list) list.push(entry);
    else byLine.set(mine.line, [entry]);
  };
  for (const l of links) {
    if (!live(l)) continue;
    if (owns(l.source.book)) add(l.source, l.target, true, l.anchor);
    if (owns(l.target.book)) add(l.target, l.source, false, undefined);
  }
  for (const s of suggestions) {
    if (s.confidence === "none" || !pending(s.id)) continue;
    if (owns(s.source.book)) add(s.source, s.target, true, s.anchor);
    if (owns(s.target.book)) add(s.target, s.source, false, undefined);
  }
  const out = new Map<number, number>();
  for (const [line, entries] of byLine) {
    const k = unitCount(entries);
    if (k > 1) out.set(line, k);
  }
  return out;
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

