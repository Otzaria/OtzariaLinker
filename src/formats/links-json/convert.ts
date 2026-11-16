import { anchorLabelFromHeRef } from "../../core/text/anchor-label";
import type { BookRef, Link, LinkSide } from "../../core/links/model";
import { isRange } from "../../core/links/model";
import { path2ForTitle, titleFromPath2 } from "../../core/links/titles";
import { mayBeSpelledOtherwise, stringifyElement } from "./layout";
import { recordFromText, type ParseIssue } from "./parse";
import type { LinksRecord } from "./record";
import { recordToObject } from "./serialize";

/*
 * The ONLY place where file coordinates (1-based) and model coordinates (0-based) meet.
 * Generator semantics (LINK_FORMATS §1.2): line_index is truncated toward zero, minus one, and
 * clamped at 0; an `_end` that is not after its start is ignored.
 */
export type ResolveBook = (title: string) => BookRef | null;

const toLine = (oneBased: number) => Math.max(0, Math.trunc(oneBased) - 1);

export function recordToLink(
  rec: LinksRecord,
  index: number,
  sourceBook: BookRef,
  resolve: ResolveBook,
  id: string,
): { link: Link; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const warn = (code: string, message: string) => issues.push({ index, level: "warning", code, message });

  const title = titleFromPath2(rec.path_2);
  let book = resolve(title);
  if (!book) {
    warn("record/target-not-found", `הספר "${title}" לא נמצא בשם מדויק בין הספרים הפתוחים. אוצריא תדלג על קישור כזה אם השם לא קיים במסד.`);
    book = { key: `unresolved:${title}`, title, origin: "unknown" };
  }

  const side = (oneBased: number, endOneBased: number | undefined, key: string): LinkSide => {
    const line = toLine(oneBased);
    if (endOneBased === undefined) return { book: sourceBook, line };
    const end = toLine(endOneBased);
    if (end < line) warn("record/range-reversed", `${key} לפני שורת ההתחלה. אוצריא מתעלמת מהטווח ומשאירה את הקישור לשורה אחת.`);
    return end > line ? { book: sourceBook, line, end } : { book: sourceBook, line };
  };
  const source = side(rec.line_index_1, rec.line_index_1_end, "סוף הטווח במקור");
  const target = { ...side(rec.line_index_2, rec.line_index_2_end, "סוף הטווח ביעד"), book };

  const label = anchorLabelFromHeRef(rec.heRef_2);
  const link: Link = {
    id,
    status: "existing",
    provenance: "file",
    source,
    target,
    declaredType: rec.connectionType,
    heRef2: rec.heRef_2,
    ...(rec.ref_1 !== undefined && { ref1: rec.ref_1 }),
    ...(rec.ref_2 !== undefined && { ref2: rec.ref_2 }),
    ...(rec.start !== undefined && {
      anchor: {
        rawStart: Math.trunc(rec.start),
        ...(rec.end !== undefined && { rawEnd: Math.trunc(rec.end) }),
        ...(label !== null && { label }),
      },
    }),
    ...(Object.keys(rec.extras).length > 0 && { passthrough: rec.extras }),
    keyOrder: rec.keyOrder,
    ...(rec.typeNull && { typeNull: true }),
    targetPath: rec.path_2,
    fileIndex: index,
  };
  const text = rec.origin ? ownText(rec, rec.origin, link) : null;
  return { link: text === null ? link : { ...link, fileText: text }, issues };
}

/**
 * The record's own bytes when writing the link back would spell it differently (review C9), else
 * null. Only a record the writer might change is compared — one whose numbers the model normalizes
 * (0 → 1, 4.5 → 4, a dropped _end), that holds a nested value (anchor_context), or whose numbers or
 * escapes the layout does not spell the same way (layout.ts mayBeSpelledOtherwise). Other spelling
 * (indentation, spacing) is the file's layout and is not compared record by record.
 */
function ownText(rec: LinksRecord, origin: NonNullable<LinksRecord["origin"]>, link: Link): string | null {
  // the numbers plainRecord writes for the link, compared without building the record (most records)
  const s = link.source;
  const t = link.target;
  const numbers =
    rec.line_index_1 !== s.line + 1 ||
    rec.line_index_1_end !== (isRange(s) ? s.end! + 1 : undefined) ||
    rec.line_index_2 !== t.line + 1 ||
    rec.line_index_2_end !== (isRange(t) ? t.end! + 1 : undefined) ||
    rec.start !== link.anchor?.rawStart ||
    rec.end !== link.anchor?.rawEnd;
  // a nested value (the pipeline's anchor_context) is often written compactly inside an indented file
  const nested = Object.values(rec.extras).some((v) => typeof v === "object" && v !== null);
  if (!numbers && !nested && !origin.spellingMayDiffer()) return null;
  const text = origin.text();
  if (text === null || (!numbers && !nested && !mayBeSpelledOtherwise(text, origin.layout()))) return null;
  if (text === stringifyElement(recordToObject(plainRecord(link)), origin.layout()) || !recordFromText(text)) return null;
  // a copy: a slice would keep the whole file's text alive for as long as the link lives
  return JSON.parse(JSON.stringify(text)) as string;
}

/**
 * Model → record, in the FILE direction of the link. Validation (what must not be written) is separate.
 * A link imported from a file keeps that record's own text (`verbatim`) while the link still means
 * exactly what that text means — otherwise, e.g. after an edit, the record is written anew.
 */
export function linkToRecord(link: Link): LinksRecord {
  const rec = plainRecord(link);
  const verbatim = link.fileText === undefined ? undefined : verbatimText(link, link.fileText, rec);
  return verbatim === undefined ? rec : { ...rec, verbatim };
}

/**
 * `text` when it decodes to a record that, read and written back by this tool, is the record the
 * link writes now — the same values in the same key order. So stale text (an edited link) or a
 * forged one (a project file is untrusted) is never written.
 */
function verbatimText(link: Link, text: string, rec: LinksRecord): string | undefined {
  const parsed = recordFromText(text);
  if (!parsed) return undefined;
  const target = link.target.book;
  const again = recordToLink(parsed, link.fileIndex ?? 0, link.source.book, (t) => (t === target.title ? target : null), link.id).link;
  return JSON.stringify(recordToObject(plainRecord(again))) === JSON.stringify(recordToObject(rec)) ? text : undefined;
}

function plainRecord(link: Link): LinksRecord {
  const s = link.source;
  const t = link.target;
  const keepPath = link.targetPath !== undefined && titleFromPath2(link.targetPath) === t.book.title;
  return {
    line_index_1: s.line + 1,
    ...(isRange(s) && { line_index_1_end: s.end! + 1 }),
    line_index_2: t.line + 1,
    ...(isRange(t) && { line_index_2_end: t.end! + 1 }),
    heRef_2: link.heRef2,
    path_2: keepPath ? link.targetPath! : path2ForTitle(t.book.title),
    connectionType: link.declaredType,
    ...(link.anchor && { start: link.anchor.rawStart }),
    ...(link.anchor?.rawEnd !== undefined && { end: link.anchor.rawEnd }),
    ...(link.ref1 !== undefined && { ref_1: link.ref1 }),
    ...(link.ref2 !== undefined && { ref_2: link.ref2 }),
    extras: { ...link.passthrough },
    keyOrder: [...(link.keyOrder ?? [])],
    ...(link.typeNull && { typeNull: true }),
  };
}
