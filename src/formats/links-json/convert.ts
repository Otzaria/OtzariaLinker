import { anchorLabelFromHeRef } from "../../core/text/anchor-label";
import type { BookRef, Link, LinkSide } from "../../core/links/model";
import { isRange } from "../../core/links/model";
import { path2ForTitle, titleFromPath2 } from "../../core/links/titles";
import type { ParseIssue } from "./parse";
import type { LinksRecord } from "./record";

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
  return { link, issues };
}

/** Model → record, in the FILE direction of the link. Validation (what must not be written) is separate. */
export function linkToRecord(link: Link): LinksRecord {
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
