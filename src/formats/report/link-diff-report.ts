import { diffGroup, type LinkDiff, type LinkDiffGroup, type LinkDiffKind } from "../../core/links/link-diff";
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
  details: "שם מקום/ref שונה",
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
  overlap: "טווחים חופפים",
  onlyA: only(a),
  onlyB: only(b),
});

const place = (s: LinkSide) => `${s.line + 1}${s.end !== undefined && s.end > s.line ? `–${s.end + 1}` : ""}`;
const sideCells = (l?: Link) => (l ? [l.source.book.title, place(l.source), l.target.book.title, place(l.target), l.declaredType, l.anchor ? String(l.anchor.rawStart) : "", l.heRef2] : ["", "", "", "", "", "", ""]);

export function linkDiffCsv(d: LinkDiff, a: string, b: string): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const side = (n: string) => [`${n}: ספר מקור`, "שורה", "ספר יעד", "שורה", "סוג", "עוגן", "שם המקום ביעד"];
  const groups = diffGroupLabels(a, b);
  const head = ["קבוצה", "שינוי", ...side(a), ...side(b)];
  const rows = d.rows.map((r) => [groups[diffGroup(r)], DIFF_KIND_LABELS[r.kind], ...sideCells(r.a), ...sideCells(r.b)].map(esc).join(","));
  return `﻿${[head.map(esc).join(","), ...rows].join("\r\n")}\r\n`;
}
