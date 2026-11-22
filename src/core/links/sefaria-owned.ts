import { scanEnd } from "../limits";
import type { BookRef, LinkSide } from "./model";
import { sefariaRefFromHeRef } from "./sefaria-ref";

/*
 * "Does the library's weekly sync treat this book as a Sefaria book" — the question behind every
 * Sefaria rule: ref_1/ref_2, no anchor end, no anchor into Sefaria, no range on a Sefaria side
 * (core/links/validate.ts sefariaChecks). It has ONE answer, decided in the state layer
 * (AppStore.isSefariaOwned, which owns the library's title list and knows each book's source). The
 * export, the quality check and the builder ask that predicate directly (ValidationContext.sefariaOwned);
 * the engines run in the worker, where the list is not loaded, so they get the predicate's answer as
 * the keys of the open books it holds for (the `sefariaOwned` engine option) — and so never propose a
 * link the export then refuses (product audit F1).
 *
 * Without an answer (an engine called directly, a test) the database origin stands in, as it does in
 * validate.ts when the context has no predicate.
 */
export type SefariaOwned = (book: BookRef) => boolean;

/** The stand-in when no one supplied the library's decision: the database says the book came from Sefaria. */
export const sefariaByOrigin: SefariaOwned = (book) => book.origin === "sefaria";

/** The engine option that carries the decision into the worker: keys of the open books it holds for. */
export interface SefariaOwnedOption {
  readonly sefariaOwned?: readonly string[];
}

/**
 * Why a single-line record on a Sefaria side cannot be written to a line, or null when it can:
 *   "heading" — the generator drops a link to a heading line;
 *   "no-ref"  — no ref_2 can be built from the line's heRef (sefaria-ref.ts): the weekly sync remaps a
 *               record by its ref_2, and a submission requires one (validate.ts sefaria/ref2-required).
 * On a Shulchan Aruch-style base the line after a siman's heading is the siman's name, with no heRef.
 */
export type RefBlock = (line: number) => "heading" | "no-ref" | null;

/** A line as far as writing a record to it on a Sefaria side goes (EngineLine and the worker's lines fit it). */
export interface RefLine {
  readonly index: number;
  readonly heading?: number | null;
  readonly heRef?: string | null;
}

const blocks = new WeakMap<readonly RefLine[], RefBlock>();

/** RefBlock over a book's lines; each line is judged once (memoized per lines array), so asking along a span is cheap. */
export function refBlockOf(lines: readonly RefLine[]): RefBlock {
  let block = blocks.get(lines);
  if (block) return block;
  let byIndex: Map<number, RefLine> | undefined;
  const at = (i: number): RefLine | undefined => (lines[i]?.index === i ? lines[i] : (byIndex ??= new Map(lines.map((l) => [l.index, l]))).get(i));
  const memo = new Map<number, "heading" | "no-ref" | null>();
  block = (i) => {
    let v = memo.get(i);
    if (v === undefined) {
      const l = at(i);
      v = l && (l.heading ?? null) !== null ? "heading" : sefariaRefFromHeRef(l?.heRef) === null ? "no-ref" : null;
      memo.set(i, v);
    }
    return v;
  };
  blocks.set(lines, block);
  return block;
}

/** RefBlock from a line's heRef alone (the citations engine knows a cited book's heRefs, not its headings). */
export function refBlockByHeRef(heRefAt: (line: number) => string | null): RefBlock {
  const memo = new Map<number, "no-ref" | null>();
  return (i) => {
    let v = memo.get(i);
    if (v === undefined) memo.set(i, (v = sefariaRefFromHeRef(heRefAt(i)) === null ? "no-ref" : null));
    return v;
  };
}

/**
 * The line a span on a Sefaria side is written to ("firstRef", LIBRARY_BENCHMARK.md §0.8): the first
 * line of [line, end] a record can be written to, and why the lines before it could not — or the span's
 * first line, with no reason, when no line in it can (the export then holds or warns, as before) or
 * when nothing is known about the lines.
 */
export function firstRefIn(line: number, end: number, block: RefBlock | undefined): { line: number; reason?: { code: string; text: string } } {
  if (!block) return { line };
  const why = block(line);
  if (why === null) return { line };
  for (let l = line + 1, last = scanEnd(line, end); l <= last; l++)
    if (block(l) === null)
      return {
        line: l,
        reason: {
          code: "range/sefaria-first-ref",
          text:
            why === "heading"
              ? `שורה ${line + 1}, שבה מתחיל הטווח, היא כותרת, וקישור לכותרת אינו נכתב. הקישור לשורה ${l + 1}, השורה הראשונה בטווח שיש לה ציון ספריא.`
              : `לשורה ${line + 1}, שבה מתחיל הטווח, אין ציון ספריא, והסנכרון של הספרייה אינו יכול לעדכן קישור אליה. הקישור לשורה ${l + 1}, השורה הראשונה בטווח שיש לה ציון ספריא.`,
        },
      };
  return { line };
}

/**
 * The longest span on a Sefaria side written as one single-line record PER LINE (owner's decision,
 * 2026-11-16, LIBRARY_BENCHMARK.md §0.8): up to this many lines every line that can carry a ref_2 gets
 * its own record — each remapped by the weekly sync by its own ref_2, so it is sync-safe, and in the app
 * the base side shows exactly as a range would. A longer span (a whole chapter, a long section) writes
 * one record, to its first such line (firstRefIn): measured, more than 20 lines held 24%–37% of the
 * every-line records for little gain.
 */
export const SPAN_EACH_LINE_MAX = 20;

/**
 * A side that may not get a range (a Sefaria side, F1): single-line records instead, and the whole place
 * it stands for as the suggestion's `citedSpan` (types.ts) — the one shape every engine collapses to.
 *   • a span of at most SPAN_EACH_LINE_MAX lines: a record for every line of it that can carry one
 *     (`lines`, when more than one; `target` is the first of them);
 *   • a longer span: one record, to its first line that can carry one — on a Shulchan Aruch-style base
 *     a section starts with the siman's name, which has no heRef and so no ref_2 (§0.8: 12,487 records
 *     in two samples; Kaf HaChaim 10,578 of 10,640);
 *   • no line of the span can carry one (or nothing is known about the lines, `block` absent): its
 *     first line, as before — the export then holds or warns.
 * `reason` says which line(s) and why, when it is not simply the span's first line. The span is not
 * written as a range; the merge reads it, so that a ד"ה line inside a heading's section is still INSIDE
 * it (merge.ts `contains`: consistent, as with the range) instead of conflicting with the written line,
 * and the real-DB measure sees what the records stand for.
 */
export function withoutRange(
  side: LinkSide,
  block?: RefBlock,
): { target: LinkSide; citedSpan?: { line: number; end: number }; lines?: number[]; reason?: { code: string; text: string } } {
  if (side.end === undefined || side.end <= side.line) return { target: side };
  const citedSpan = { line: side.line, end: side.end };
  const span = `${side.line + 1}–${side.end + 1}`;
  if (block && side.end - side.line + 1 <= SPAN_EACH_LINE_MAX) {
    const lines: number[] = [];
    for (let l = side.line, last = scanEnd(side.line, side.end); l <= last; l++) if (block(l) === null) lines.push(l);
    if (lines.length > 1) {
      const skipped = side.end - side.line + 1 - lines.length;
      return {
        target: { book: side.book, line: lines[0]! },
        citedSpan,
        lines,
        reason: {
          code: "range/sefaria-each-line",
          text: `הקישור עומד לשורות ${span}. זה ספר ספריא, והספרייה אינה מקבלת טווח בצד שלו, ולכן נכתב קישור נפרד לכל שורה בטווח שיש לה ציון ספריא: ${lines.length} קישורים${skipped ? ` (${skipped} שורות בלי ציון או כותרות דולגו)` : ""}. אישור או דחייה חלים על כולם יחד.`,
        },
      };
    }
  }
  const at = firstRefIn(side.line, side.end, block);
  return { target: { book: side.book, line: at.line }, citedSpan, ...(at.reason && { reason: at.reason }) };
}

/** The library's list of Sefaria titles inside a library checkout: a folder holding it is the library (sefaria-titles.ts). */
export const SEFARIA_TITLES_PATH = ".github/data/sefaria_he_titles.txt";

/** The predicate an engine uses: the keys it was given, else the database origin. */
export function sefariaOwnedOf(keys: readonly string[] | undefined): SefariaOwned {
  if (!keys) return sefariaByOrigin;
  const set = new Set(keys);
  return (book) => set.has(book.key);
}
