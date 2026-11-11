import type { BookHeading } from "../../core/books";
import type { BookRef, Link } from "../../core/links/model";
import { CONNECTION_TYPE_KEY } from "../links-json/record";

/*
 * Links as CSV in Sefaria's link-upload layout — the "CSV בפורמט ספריא" export of version 3
 * (legacy/OtzariaLinker-v3.html, `ExportBuilder.buildCsv`, and the export dialog's `csv` branch).
 * The format is reproduced byte for byte:
 *   • one file per source book, named "<source title>.links.csv";
 *   • header `Citation 1,Citation 2,Conection Type` (the generator's one-"n" key, as v3 wrote it);
 *   • a field is quoted only when it holds `"`, `,` or a line feed, with `"` doubled;
 *   • rows joined with "\n", no line break after the last row, no BOM;
 *   • Citation 1 = the source line's heading trail ("אורח חיים, סימן א"), or the book title when
 *     no heading precedes it; Citation 2 = the link's heRef_2 (v3: `heRef`, else the target's
 *     heading trail); the third column is the connection type exactly as the links file gets it.
 * Ranges and word anchors have no column here — v3 left them out too; the JSON export keeps them.
 */
export const SEFARIA_CSV_HEADER = `Citation 1,Citation 2,${CONNECTION_TYPE_KEY}`;

export const sefariaCsvFileName = (sourceTitle: string): string => `${sourceTitle}.links.csv`;

export function csvField(value: unknown): string {
  const v = String(value ?? "");
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export interface SefariaCsvRow {
  citation1: string;
  citation2: string;
  type: string;
}

export function sefariaCsv(rows: readonly SefariaCsvRow[]): string {
  return [SEFARIA_CSV_HEADER, ...rows.map((r) => [csvField(r.citation1), csvField(r.citation2), csvField(r.type)].join(","))].join("\n");
}

/**
 * The heading trail of a line: for every level 1–6, the last heading at or before the line, with
 * deeper levels reset by a shallower heading; joined with ", ". The book title when there is none.
 * `headings` must be in line order.
 */
export function citationAt(headings: readonly BookHeading[], line: number, title: string): string {
  const active: (string | undefined)[] = [];
  for (const h of headings) {
    if (h.line > line) break;
    active[h.level] = h.text;
    active.length = h.level + 1;
  }
  const trail = active.filter((t): t is string => !!t);
  return trail.length ? trail.join(", ") : title;
}

export interface SefariaCsvFile {
  name: string;
  sourceTitle: string;
  text: string;
  rows: number;
}

/**
 * One CSV per source book from the links the export writes (ExportPlan.written — the same rules
 * decide what is written, DEVELOPER_GUIDE §5.3). `headingsOf` returns a book's headings in line
 * order, or undefined when the book is not open (the citation then falls back to the title).
 */
export function planSefariaCsv(links: readonly Link[], headingsOf: (book: BookRef) => readonly BookHeading[] | undefined): SefariaCsvFile[] {
  const bySource = new Map<string, SefariaCsvRow[]>();
  const ordered = [...links].sort((a, b) => cmp(a.source.book.title, b.source.book.title) || a.source.line - b.source.line || a.target.line - b.target.line);
  for (const l of ordered) {
    const rows = bySource.get(l.source.book.title) ?? [];
    rows.push({
      citation1: citationAt(headingsOf(l.source.book) ?? [], l.source.line, l.source.book.title),
      citation2: l.heRef2 || citationAt(headingsOf(l.target.book) ?? [], l.target.line, l.target.book.title),
      type: l.declaredType,
    });
    bySource.set(l.source.book.title, rows);
  }
  return [...bySource.entries()]
    .sort(([a], [b]) => cmp(a, b))
    .map(([title, rows]) => ({ name: sefariaCsvFileName(title), sourceTitle: title, text: sefariaCsv(rows), rows: rows.length }));
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
