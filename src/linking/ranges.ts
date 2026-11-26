import { linePairIdentity } from "../core/links/equality";
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
 * A cut that would end on a heading steps back from it, like every other end here: a new link is
 * most often made on the line right after a heading, and Otzaria drops a range that ends on one.
 */
export function trimBefore(links: Iterable<Link>, book: RangeBook, side: RangeSide, newStart: number, exclude?: string): RangeEdit[] {
  const out: RangeEdit[] = [];
  for (const l of links) {
    if (!live(l) || l.id === exclude || l.provenance === "db") continue;
    const s = sideOf(l, side);
    if (!book.owns(s.book) || s.end === undefined || s.line >= newStart || s.end < newStart) continue;
    const end = backFromHeading(newStart - 1, s.line, book.headings);
    out.push({ link: l, side, before: s.end, after: end > s.line ? end : undefined });
  }
  return out;
}

export interface FillOptions {
  /** true (default, as in v3): only links that already have a range on this side; false: every link */
  readonly onlyRanged?: boolean;
}

/**
 * Range completion (v3 `autoFillBook`): every link of the book on this side gets the module's range,
 * exactly what `suggestEnd` gives — until one line before the next marker (a link's start or a
 * heading), the last until the end of the book. v3 used only link starts, so a range ran across
 * chapter headings; here it stops at the chapter. A range that already swallows the next link's start
 * and has no room left is removed (the link becomes a single line) rather than left overlapping.
 * Only real changes are returned. A book whose length is unknown (a "shadow" book that came from a
 * links file, with no text) is never touched: the ranges imported with it could only be lost.
 */
export function fillRanges(links: Iterable<Link>, book: RangeBook, side: RangeSide, options: FillOptions = {}): { edits: RangeEdit[]; skippedNoText: boolean } {
  if (book.lineCount <= 0) return { edits: [], skippedNoText: true };
  const onlyRanged = options.onlyRanged !== false;
  const mine = [...links].filter((l) => live(l) && l.provenance !== "db" && book.owns(sideOf(l, side).book));
  // the project's own links and the headings; database links are not this book's ranges to keep apart
  const markers = rangeMarkers(mine, book, side, "auto");
  const edits: RangeEdit[] = [];
  for (const l of mine) {
    const s = sideOf(l, side);
    if (onlyRanged && s.end === undefined) continue;
    const want = suggestEnd(s.line, markers, book);
    if (want <= s.line) {
      if (s.end !== undefined) edits.push({ link: l, side, before: s.end, after: undefined });
      continue;
    }
    if (want === s.end) continue;
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

/* ---------------- "this passage continues the previous one" (V7 §2.13, issue #44) ---------------- */

/** "extend": a range over the new line where the export allows one (else a copy); "copy": always an independent link. */
export type ContinueMode = "extend" | "copy";

export interface ContinueItem {
  /** a link of the previous passage */
  readonly prev: Link;
  readonly action: "extend" | "copy" | "skip";
  /** skip: "covered" (it already reaches the line) or "duplicate" (the copy is a link already there); copy: "range-refused" */
  readonly why?: "covered" | "duplicate" | "range-refused";
  /** range-refused: what the export says about the range (validate.ts) */
  readonly detail?: string;
  /** the changed link (extend, same id) or the new one (copy) */
  readonly after?: Link;
}

export interface ContinuePlan {
  readonly side: RangeSide;
  /** the line that continues the previous passage (0-based) */
  readonly line: number;
  /** the previous passage: the last line before `line` that a link of this side covers; null when refused */
  readonly fromLine: number | null;
  /** heading lines between the two: a structural boundary that needs the user's explicit confirmation */
  readonly headings: readonly number[];
  /** "heading-line": the line is a heading (Otzaria drops a link to it); "no-previous": no link before it on this side */
  readonly refused?: "heading-line" | "no-previous";
  readonly items: readonly ContinueItem[];
}

export interface ContinueOptions {
  readonly mode?: ContinueMode;
  /** a new link id for each copy */
  readonly newId: () => string;
  /** null when the export accepts the extended link as it accepted it before; else what it says about the range */
  readonly rangeRefused?: (before: Link, after: Link) => string | null;
  /** true for a link that is already there outside `links` (the open database's links) */
  readonly exists?: (l: Link) => boolean;
  /** heRef_2 of a copy whose TARGET is the continuing line (the passage book is the link's target) */
  readonly heRef2?: (line: number) => string;
}

const coverEnd = (s: LinkSide) => (s.end !== undefined && s.end > s.line ? s.end : s.line);

/**
 * The plan for "line `line` continues the previous passage" (pure; nothing changes until the store applies it).
 * The previous passage is the last line before `line` that a live link of this side covers; every link that covers
 * it is inherited: its range is extended over the new line (`mode` "extend", when the export accepts a range for that
 * link — `rangeRefused` — and it is not a read-only database link), or it is copied to the new line as an independent
 * link with the same other side, type and label. A link that already reaches the line is left alone, and a copy that
 * would duplicate a link already there (equality.ts, "same lines"; also `exists`) is not made. Headings between the
 * two lines are reported, never crossed silently: the caller asks for a confirmation.
 */
export function planContinuation(links: Iterable<Link>, book: RangeBook, side: RangeSide, line: number, options: ContinueOptions): ContinuePlan {
  const mode = options.mode ?? "extend";
  const all = [...links].filter(live);
  const refused = (why: ContinuePlan["refused"]): ContinuePlan => ({ side, line, fromLine: null, headings: [], refused: why, items: [] });
  if (book.headings.has(line)) return refused("heading-line");
  const mine = all.filter((l) => book.owns(sideOf(l, side).book) && sideOf(l, side).line < line);
  if (!mine.length) return refused("no-previous");
  const fromLine = Math.max(...mine.map((l) => Math.min(coverEnd(sideOf(l, side)), line - 1)));
  const prevs = mine
    .filter((l) => sideOf(l, side).line <= fromLine && fromLine <= coverEnd(sideOf(l, side)))
    .sort((a, b) => sideOf(a, side).line - sideOf(b, side).line || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const headings = [...book.headings].filter((h) => h > fromLine && h < line).sort((a, b) => a - b);

  // the one equality rule (core/links/equality.ts): the same two lines, in any direction and of any type
  const pairs = new Set(all.map((l) => linePairIdentity(l)));
  const items: ContinueItem[] = [];
  for (const prev of prevs) {
    const s = sideOf(prev, side);
    if (coverEnd(s) >= line) {
      items.push({ prev, action: "skip", why: "covered" });
      continue;
    }
    let detail: string | undefined;
    if (mode === "extend" && prev.provenance !== "db") {
      const before = prev.continued?.kind === "extend" && prev.continued.side === side ? prev.continued : undefined;
      const baseEnd = before ? before.baseEnd : isRangeSide(s) ? s.end : undefined;
      const baseStatus = before ? before.baseStatus : prev.status === "existing" ? "existing" : undefined;
      const after: Link = {
        ...applyRangeEdit(prev, side, line),
        continued: { kind: "extend", side, fromLine: before ? before.fromLine : fromLine, ...(baseEnd !== undefined && { baseEnd }), ...(baseStatus && { baseStatus }) },
      };
      const why = options.rangeRefused?.(prev, after) ?? null;
      if (why === null) {
        items.push({ prev, action: "extend", after });
        continue;
      }
      detail = why;
    }
    const copy = continuationCopy(prev, side, line, fromLine, options);
    const key = linePairIdentity(copy);
    if (pairs.has(key) || options.exists?.(copy)) {
      items.push({ prev, action: "skip", why: "duplicate" });
      continue;
    }
    pairs.add(key);
    items.push({ prev, action: "copy", after: copy, ...(detail !== undefined && { why: "range-refused" as const, detail }) });
  }
  return { side, line, fromLine, headings, items };
}

const isRangeSide = (s: LinkSide) => s.end !== undefined && s.end > s.line;

/** An independent link for the continuing line: the other side, the type and the label of `prev`; nothing of its record's shape. */
function continuationCopy(prev: Link, side: RangeSide, line: number, fromLine: number, options: ContinueOptions): Link {
  const here: LinkSide = { book: sideOf(prev, side).book, line };
  return {
    id: options.newId(),
    status: "new",
    provenance: "user",
    source: side === "source" ? here : prev.source,
    target: side === "target" ? here : prev.target,
    declaredType: prev.declaredType,
    // heRef_2 and ref_2 describe the target: kept while it is the same; ref_1 describes the source line
    heRef2: side === "target" ? (options.heRef2?.(line) ?? prev.heRef2) : prev.heRef2,
    ...(side === "source" && prev.ref2 !== undefined && { ref2: prev.ref2 }),
    ...(side === "target" && prev.ref1 !== undefined && { ref1: prev.ref1 }),
    continued: { kind: "copy", side, fromLine, from: prev.id },
  };
}

/**
 * What cancelling a link's continuation makes of it: an extended link gets back the range (and the untouched status) it
 * had before the first continuation; a copy is removed (null); a link with no continuation is not touched (undefined).
 */
export function cancelContinuationEdit(l: Link): Link | null | undefined {
  const c = l.continued;
  if (!c) return undefined;
  if (c.kind === "copy") return null;
  const { continued: _c, ...rest } = applyRangeEdit(l, c.side, c.baseEnd);
  return { ...rest, status: c.baseStatus ?? rest.status };
}

/* ---------------- the ranges of a RUN: "until the next match" (v3 F-104, `runMatches` with a range kind) ---------------- */

/**
 * How a run sets the range on each side of what it proposes, an option of every pair engine (option-specs.ts) that travels with the
 * engine's options — so a job stores it and its fingerprint changes with it (batch-job.ts stepsSignature):
 *   "engine"      (default) what the engine proposes, untouched (the headings engine's section, dibur-hamatchil's item ranges);
 *   "line"        one line: the engine's range on that side is dropped (and a span's single-line records, keeping the first);
 *   "next-match"  v3's "range until the next match" (link kinds rangeSource / rangeTarget / rangeBoth): from the line to one line before
 *                 the next line that a suggestion of THE SAME RUN starts on that side, or before a heading (as every range here: a range
 *                 never runs over a chapter, and never ends on a heading); the last one to the end of the book. v3 counted only the
 *                 matches the user ticked, at approval; here every suggestion of the run counts, so the range is known before approval and
 *                 is the same whichever way it is approved.
 * The sides are the run's BOOKS, not the record's direction: "source" is the book the run links from (the commentary; dibur-hamatchil
 * may write the record base → commentary). No range is set on a book the library treats as Sefaria's (sefaria-owned.ts): the weekly sync
 * remaps only a record's start. With a line filter, only the suggestions it keeps count as matches, and it then trims a range over an
 * excluded line (source-filter.ts LineGate.keeps, LineGate.rangeEnd).
 */
export type RunRangeMode = "engine" | "line" | "next-match";
export interface RunRangeOptions {
  readonly sourceRange?: RunRangeMode;
  readonly targetRange?: RunRangeMode;
}
export const RUN_RANGE_KEYS = ["sourceRange", "targetRange"] as const;
export const RUN_RANGE_MODES: readonly RunRangeMode[] = ["engine", "line", "next-match"];

/** One book of the run as the range rule needs it: its length and heading lines; `sefaria`: no range may be written on it. */
export interface RunRangeBook {
  readonly key: string;
  readonly lineCount: number;
  readonly headings: ReadonlySet<number>;
  readonly sefaria?: boolean;
}

/** The parts of a suggestion the range rule reads and writes (automatic/types.ts Suggestion, kept structural). */
interface RangedSuggestion {
  readonly source: LinkSide;
  readonly target: LinkSide;
  readonly spanLines?: readonly { readonly line: number; readonly heRef2: string }[];
  readonly reasons: readonly { readonly code: string; readonly text: string }[];
  readonly rules: readonly string[];
}

const singleOf = (s: LinkSide): LinkSide => {
  const { end: _e, ...rest } = s;
  return rest;
};

const ROLE_TEXT = { source: "בספר המקשר", target: "בספר שאליו מקשרים" } as const;

/**
 * The run's suggestions with the range of each side set by `options` (see RunRangeMode). Pure; the input is not changed, a suggestion
 * that does not change is the same object, and the notes say what was done (none when nothing was asked).
 * `kept`: which suggestions will survive the run's line filter (index.ts engineSteps, LineGate.guard). Only they are "the next match": a
 * suggestion the guard drops later must not end the range of the one before it, on either side (V7 round 2 review, finding 10). Every
 * suggestion still gets its range — a dropped one is dropped anyway.
 */
export function applyRunRanges<S extends RangedSuggestion>(
  suggestions: readonly S[],
  books: { readonly source: RunRangeBook; readonly target: RunRangeBook },
  options: RunRangeOptions,
  kept: (s: S) => boolean = () => true,
): { suggestions: S[]; notes: { code: string; text: string }[] } {
  const modes = { source: options.sourceRange ?? "engine", target: options.targetRange ?? "engine" } as const;
  if (modes.source === "engine" && modes.target === "engine") return { suggestions: [...suggestions], notes: [] };
  /** which side of the record lies in the run's book of `role` (the record may run the other way) */
  const sideIn = (s: S, role: "source" | "target"): "source" | "target" | null => {
    const key = books[role].key;
    if (role === "source") return s.source.book.key === key ? "source" : s.target.book.key === key ? "target" : null;
    return s.target.book.key === key ? "target" : s.source.book.key === key ? "source" : null;
  };
  const markersOf = (role: "source" | "target"): number[] => {
    const set = new Set<number>(books[role].headings);
    for (const s of suggestions) {
      if (!kept(s)) continue;
      const side = sideIn(s, role);
      if (side) set.add(s[side].line);
    }
    return [...set].sort((a, b) => a - b);
  };
  const marks = { source: modes.source === "next-match" ? markersOf("source") : [], target: modes.target === "next-match" ? markersOf("target") : [] };
  let sefariaSkipped = false;
  const out = suggestions.map((s) => {
    let next: S = s;
    for (const role of ["source", "target"] as const) {
      const mode = modes[role];
      if (mode === "engine") continue;
      const side = sideIn(next, role);
      if (!side) continue;
      const cur = next[side];
      const records = side === "target" && next.spanLines && next.spanLines.length > 1;
      if (mode === "line") {
        if (cur.end === undefined && !records) continue;
        next = { ...next, [side]: singleOf(cur), ...(records && { spanLines: next.spanLines!.slice(0, 1) }) };
        continue;
      }
      const book = books[role];
      if (book.sefaria) {
        sefariaSkipped = true;
        continue;
      }
      const end = suggestEnd(cur.line, marks[role], book);
      const want: LinkSide = end > cur.line ? { ...singleOf(cur), end } : singleOf(cur);
      if (want.end === cur.end) continue;
      next = {
        ...next,
        [side]: want,
        reasons: [
          ...next.reasons,
          {
            code: `range/${role}-next-match`,
            text:
              want.end !== undefined
                ? `הטווח ${ROLE_TEXT[role]} נמשך עד לפני ההתאמה הבאה של ההרצה (שורות ${cur.line + 1}–${want.end + 1}).`
                : `${ROLE_TEXT[role]} ההתאמה הבאה של ההרצה, או כותרת, נמצאת בשורה שאחרי, ולכן אין טווח.`,
          },
        ],
        rules: [...next.rules, `ranges.${role}-next-match`],
      };
    }
    return next;
  });
  const said = (mode: RunRangeMode) => (mode === "line" ? "שורה אחת בלבד" : "עד לפני ההתאמה הבאה של ההרצה, או לפני כותרת");
  const parts = (["source", "target"] as const).filter((r) => modes[r] !== "engine").map((r) => `${ROLE_TEXT[r]}: ${said(modes[r])}`);
  const notes = [{ code: "range/run-ranges", text: `הטווחים נקבעו לפי הגדרת ההרצה. ${parts.join("; ")}.` }];
  if (sefariaSkipped) notes.push({ code: "range/run-ranges-sefaria", text: "בספר של ספריא לא נוסף טווח עד ההתאמה הבאה: הספרייה לא מקבלת טווח בצד שלו." });
  return { suggestions: out, notes };
}
