import { humanCsvCell } from "../../core/csv";
import { detailDifferences, type DetailField, diffGroup, type LinkDiff, type LinkDiffGroup, type LinkDiffKind } from "../../core/links/link-diff";
import type { Link, LinkSide } from "../../core/links/model";

/*
 * The links comparison as a CSV report (UTF-8 with BOM, so Excel shows Hebrew), one row per paired
 * or unpaired link, both sides in the file's own terms: 1-based lines, ranges "5–7", the declared type.
 */
export const DIFF_KIND_LABELS: Readonly<Record<LinkDiffKind, string>> = {
  same: "זהה",
  range: "טווח שונה",
  anchor: "עוגן שונה",
  type: "סוג שונה",
  direction: "כיוון הפוך",
  ref: "ציון ספריא שונה",
  details: "שם המקום שונה",
  target: "יעד שונה",
  moved: "עבר לשורה אחרת",
  removed: "נמחק",
  added: "נוסף",
};

/** "רק במסד", "רק בפרויקט", "רק ב־x_links.json" */
const only = (name: string) => (name.startsWith("ה") && !name.includes(".") ? `רק ב${name.slice(1)}` : `רק ב־${name}`);

export const diffGroupLabels = (a: string, b: string): Readonly<Record<LinkDiffGroup, string>> => ({
  identical: "זהים",
  conflict: "סותרים",
  refs: "ציוני ספריא שונים",
  details: "רק שם המקום",
  overlap: "טווחים חופפים",
  onlyA: only(a),
  onlyB: only(b),
});

/** The detail fields in the user's words (the fields of the file are heRef_2, ref_1, ref_2) */
export const DETAIL_LABELS: Readonly<Record<DetailField, string>> = { heRef2: "שם המקום ביעד", ref1: "ציון ספריא בספר המקור", ref2: "ציון ספריא בספר היעד" };

/**
 * What a "details" or "ref" row says on each side: only the fields that differ, quoted so that a space or an empty
 * value is visible ("שם המקום ביעד: «x» ← «y»" shows the two as the same line would hide it, #15).
 */
export function detailsText(a: Link | undefined, b: Link | undefined, side: "a" | "b"): string {
  if (!a || !b) return "";
  return detailDifferences(a, b)
    .map((d) => `${DETAIL_LABELS[d.field]}: ${d[side] ? `«${d[side]}»` : "ריק"}`)
    .join(" · ");
}

const place = (s: LinkSide) => `${s.line + 1}${s.end !== undefined && s.end > s.line ? `–${s.end + 1}` : ""}`;
const sideCells = (l?: Link) => (l ? [l.source.book.title, place(l.source), l.target.book.title, place(l.target), l.declaredType, l.anchor ? String(l.anchor.rawStart) : "", l.heRef2, l.ref1 ?? "", l.ref2 ?? ""] : ["", "", "", "", "", "", "", "", ""]);

export function linkDiffCsv(d: LinkDiff, a: string, b: string): string {
  const esc = humanCsvCell;
  const side = (n: string) => [`${n}: ספר מקור`, "שורה", "ספר יעד", "שורה", "סוג", "עוגן", "שם המקום ביעד", "ref_1", "ref_2"];
  const groups = diffGroupLabels(a, b);
  const head = ["קבוצה", "שינוי", ...side(a), ...side(b)];
  const rows = d.rows.map((r) => [groups[diffGroup(r)], DIFF_KIND_LABELS[r.kind], ...sideCells(r.a), ...sideCells(r.b)].map(esc).join(","));
  return `﻿${[head.map(esc).join(","), ...rows].join("\r\n")}\r\n`;
}
