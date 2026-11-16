import type { LineFate } from "../matching/line-diff";

/*
 * The alignment of two editions of a book (matching/line-diff.ts) as rows a person can read and keep
 * (stages 11 and 15): the diff view of the relink dialog pages through these rows, and the mapping
 * file old → new is written from them. Pure and deterministic; it only describes the alignment —
 * moving links is relink.ts, and a "moved" line is never used to move a link.
 *
 * Row kinds:
 *   same     — identical line (by unique anchor or exact match), maybe at another number;
 *   changed  — an edited line, paired by word similarity;
 *   moved    — a line found verbatim elsewhere in the new edition (findMoves), at its OLD place;
 *   moved-in — the same line at its NEW place (view only: the mapping already has it as "moved");
 *   deleted  — an old line with no counterpart;
 *   inserted — a new line with no counterpart.
 */
export type EditionRowKind = "same" | "changed" | "moved" | "moved-in" | "deleted" | "inserted";

export interface EditionRow {
  /** 0-based line of the old edition, -1 for none */
  old: number;
  /** 0-based line of the new edition, -1 for none */
  new: number;
  kind: EditionRowKind;
}

export interface EditionDiff {
  /** old line → new line or -1 (strictly increasing where ≥ 0, as diffLines guarantees) */
  to: ArrayLike<number>;
  fate: readonly LineFate[];
  /** [old, new] of verbatim moves; both ends unmatched in `to` */
  moves: readonly (readonly [number, number])[];
  newLength: number;
  /** word similarity per old line (for "changed"), 0..1 */
  similarity?: ArrayLike<number>;
}

/**
 * The rows in reading order: each old line at its place, and each new line without an old
 * counterpart just before the next aligned pair — deletions first, then insertions, as a diff reads.
 */
export function editionRows(d: EditionDiff): EditionRow[] {
  const movedTo = new Map<number, number>(d.moves.map(([i, j]) => [i, j]));
  const movedFrom = new Map<number, number>(d.moves.map(([i, j]) => [j, i]));
  const rows: EditionRow[] = [];
  let j = 0;
  const newUpTo = (end: number) => {
    for (; j < end; j++) rows.push(movedFrom.has(j) ? { old: movedFrom.get(j)!, new: j, kind: "moved-in" } : { old: -1, new: j, kind: "inserted" });
  };
  for (let i = 0; i < d.to.length; i++) {
    const t = d.to[i]!;
    if (t >= 0) {
      newUpTo(t);
      rows.push({ old: i, new: t, kind: d.fate[i] === "changed" ? "changed" : "same" });
      j = t + 1;
    } else if (movedTo.has(i)) rows.push({ old: i, new: movedTo.get(i)!, kind: "moved" });
    else rows.push({ old: i, new: -1, kind: "deleted" });
  }
  newUpTo(d.newLength);
  return rows;
}

/** How many rows of each kind. */
export function rowCounts(rows: readonly EditionRow[]): Record<EditionRowKind, number> {
  const c: Record<EditionRowKind, number> = { same: 0, changed: 0, moved: 0, "moved-in": 0, deleted: 0, inserted: 0 };
  for (const r of rows) c[r.kind]++;
  return c;
}

export const ROW_KIND_LABEL: Readonly<Record<EditionRowKind, string>> = {
  same: "זהה",
  changed: "נערכה",
  moved: "הוזזה",
  "moved-in": "הוזזה לכאן",
  deleted: "נמחקה",
  inserted: "נוספה",
};

/**
 * The line mapping old → new as CSV, with the conventions of the QA CSV (linking/qa.ts): UTF-8 with
 * BOM, CRLF, every value quoted, line numbers 1-based like the links file. One row per old line and
 * one per inserted new line ("moved-in" rows are the other end of a "moved" row and are left out), so
 * every line of each edition appears exactly once. The code column is stable (EditionRowKind).
 */
export function lineMappingCsv(rows: readonly EditionRow[], d?: Pick<EditionDiff, "similarity">): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const head = ["שורה במהדורה הישנה", "שורה במהדורה החדשה", "מצב", "דמיון", "קוד"];
  const out = [head.map(esc).join(",")];
  for (const r of rows) {
    if (r.kind === "moved-in") continue;
    const sim = r.kind === "changed" && d?.similarity ? `${Math.round((d.similarity[r.old] ?? 0) * 100)}%` : "";
    out.push([r.old >= 0 ? r.old + 1 : "", r.new >= 0 ? r.new + 1 : "", ROW_KIND_LABEL[r.kind], sim, r.kind].map(esc).join(","));
  }
  return `﻿${out.join("\r\n")}\r\n`;
}
