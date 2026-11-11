import { sourceTitleFromLinksFileName } from "../../core/links/titles";
import { CONNECTION_TYPE_KEY } from "../links-json/record";

/*
 * Links as CSV/TSV (stage 6/10) — for people who keep links in a spreadsheet. The header row names
 * the columns with the `_links.json` field names (line_index_1, heRef_2, path_2, line_index_2,
 * "Conection Type", optionally line_index_1_end, line_index_2_end, start, end, ref_1, ref_2).
 * The source book is the file name ("<title>_links.csv") or a `source_title` column, so one sheet
 * may hold links of many books. Rows become links-json text per source book, and go through the
 * same parser as a links file — one set of rules for both.
 */
export interface CsvLinksResult {
  /** per source title, a `_links.json` text to import */
  files: { sourceTitle: string; text: string; rows: number }[];
  problems: string[];
}

const NUMERIC = new Set(["line_index_1", "line_index_1_end", "line_index_2", "line_index_2_end", "start", "end"]);
const ALIASES: Record<string, string> = { "connection type": CONNECTION_TYPE_KEY, "conection type": CONNECTION_TYPE_KEY, type: CONNECTION_TYPE_KEY, source: "source_title", "ספר מקור": "source_title" };

export function parseLinksCsv(text: string, fileName: string): CsvLinksResult {
  const delimiter = /\.tsv$/i.test(fileName) || (text.split(/\r?\n/, 1)[0] ?? "").includes("\t") ? "\t" : ",";
  const rows = parseDelimited(text.replace(/^﻿/, ""), delimiter);
  const problems: string[] = [];
  if (rows.length < 2) return { files: [], problems: ["בקובץ אין שורות נתונים מתחת לשורת הכותרות."] };
  const header = rows[0]!.map((h) => ALIASES[h.trim().toLowerCase()] ?? h.trim());
  for (const need of ["line_index_1", "heRef_2", "path_2", "line_index_2", CONNECTION_TYPE_KEY])
    if (!header.includes(need)) problems.push(`חסרה עמודה "${need}" בשורת הכותרות.`);
  if (problems.length) return { files: [], problems };

  const fromName = sourceTitleFromLinksFileName(fileName.replace(/\.(csv|tsv)$/i, ".json"));
  const bySource = new Map<string, Record<string, unknown>[]>();
  rows.slice(1).forEach((cells, r) => {
    if (cells.every((c) => !c.trim())) return;
    const rec: Record<string, unknown> = {};
    header.forEach((h, i) => {
      const v = (cells[i] ?? "").trim();
      if (!v) return;
      rec[h] = NUMERIC.has(h) && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    });
    const source = String(rec.source_title ?? fromName ?? "");
    delete rec.source_title;
    if (!source) return void problems.push(`שורה ${r + 2}: לא ידוע מהו ספר המקור (אין עמודת source_title, ושם הקובץ אינו "<ספר>_links.csv").`);
    bySource.set(source, [...(bySource.get(source) ?? []), rec]);
  });
  return { files: [...bySource].map(([sourceTitle, recs]) => ({ sourceTitle, text: JSON.stringify(recs, null, 2), rows: recs.length })), problems };
}

/** RFC 4180: quoted fields, "" inside quotes, delimiters and line breaks inside quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) (row.push(field), rows.push(row));
  return rows;
}
