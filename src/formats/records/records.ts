import { sourceTitleFromLinksFileName } from "../../core/links/titles";
import { parseDelimited } from "../links-csv/parse";
import { CONNECTION_TYPE_KEY } from "../links-json/record";

/*
 * Links kept in someone else's layout (plan stages 6 and 10): a JSON array of objects, an object
 * holding such an array, JSON Lines, or a CSV/TSV whose columns are not the library's field names.
 * The user maps fields once (guessed by name, see `guessRecordsMapping`); `recordsToLinksFiles`
 * then writes ordinary `_links.json` records per source book, so the import goes through the same
 * parser and validation as a library file — one set of rules.
 */

export interface RecordsTable {
  /** every field name seen, in first-seen order */
  fields: string[];
  /** values as text ("" = absent) */
  rows: Record<string, string>[];
  layout: "json" | "jsonl" | "csv" | "tsv";
}

/** A field of the file, a fixed value for every row, or (source only) the file name. */
export type FieldOrFixed = { field: string } | { fixed: string };

export interface RecordsMapping {
  source: FieldOrFixed | { fromFileName: true };
  sourceLine: string;
  sourceLineEnd?: string;
  /** the target as a title (or file name): becomes path_2 "<title>.txt" when no path field is mapped */
  targetTitle?: string;
  targetPath?: string;
  targetLine: string;
  targetLineEnd?: string;
  heRef2?: string;
  type: FieldOrFixed;
  start?: string;
  end?: string;
  /** how lines are numbered in the file; the library counts from 1 */
  base: 0 | 1;
}

const MAX_ROWS = 2_000_000;

/** Reads a table of records, or null when the text is not one (then it is not offered for mapping). */
export function parseRecords(text: string, fileName: string): RecordsTable | null {
  const t = text.replace(/^﻿/, "");
  const trimmed = t.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let data: unknown;
    try {
      data = JSON.parse(t);
    } catch {
      return parseJsonl(t);
    }
    const arr = Array.isArray(data) ? data : findArray(data);
    return arr ? fromObjects(arr, "json") : null;
  }
  if (/\.(csv|tsv)$/i.test(fileName) || /[,\t]/.test(t.split(/\r?\n/, 1)[0] ?? "")) {
    const tab = /\.tsv$/i.test(fileName) || (t.split(/\r?\n/, 1)[0] ?? "").includes("\t");
    const rows = parseDelimited(t, tab ? "\t" : ",");
    if (rows.length < 2) return null;
    const fields = rows[0]!.map((h) => h.trim());
    return {
      fields,
      rows: rows.slice(1, MAX_ROWS + 1).filter((c) => c.some((v) => v.trim())).map((c) => Object.fromEntries(fields.map((f, i) => [f, (c[i] ?? "").trim()]))),
      layout: tab ? "tsv" : "csv",
    };
  }
  return null;
}

function parseJsonl(t: string): RecordsTable | null {
  const objs: unknown[] = [];
  for (const line of t.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      objs.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return objs.length ? fromObjects(objs, "jsonl") : null;
}

/** `{ "links": [...] }` and similar: the first property holding an array of objects. */
function findArray(data: unknown): unknown[] | null {
  if (!data || typeof data !== "object") return null;
  for (const v of Object.values(data)) if (Array.isArray(v) && v.some((x) => x && typeof x === "object" && !Array.isArray(x))) return v;
  return null;
}

function fromObjects(arr: readonly unknown[], layout: "json" | "jsonl"): RecordsTable | null {
  const fields: string[] = [];
  const seen = new Set<string>();
  const rows: Record<string, string>[] = [];
  for (const o of arr.slice(0, MAX_ROWS)) {
    if (!o || typeof o !== "object" || Array.isArray(o)) continue;
    const row: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v === null || v === undefined || typeof v === "object") continue; // nested values are not mappable
      if (!seen.has(k)) seen.add(k), fields.push(k);
      Object.defineProperty(row, k, { value: String(v).trim(), enumerable: true, writable: true, configurable: true });
    }
    rows.push(row);
  }
  return rows.length && fields.length ? { fields, rows, layout } : null;
}

/* ---------------- guessing ---------------- */

const SYNONYMS: Record<Exclude<keyof RecordsMapping, "source" | "type" | "base">, readonly string[]> = {
  sourceLine: ["line_index_1", "source_line", "sourceline", "from_line", "line1", "line_1", "שורת מקור", "שורה 1", "שורה במקור"],
  sourceLineEnd: ["line_index_1_end", "source_line_end", "from_line_end", "line1_end", "סוף שורת מקור"],
  targetTitle: ["target", "target_title", "target_book", "to_book", "book_2", "title_2", "ספר יעד", "יעד"],
  targetPath: ["path_2", "target_path", "to_path", "file_2"],
  targetLine: ["line_index_2", "target_line", "targetline", "to_line", "line2", "line_2", "שורת יעד", "שורה 2", "שורה ביעד"],
  targetLineEnd: ["line_index_2_end", "target_line_end", "to_line_end", "line2_end", "סוף שורת יעד"],
  heRef2: ["heref_2", "heref2", "target_ref", "ref_he", "מקום ביעד", "שם המקום"],
  start: ["start", "anchor_start", "char_start"],
  end: ["end", "anchor_end", "char_end"],
};
const SOURCE_SYNONYMS = ["source_title", "source", "source_book", "from_book", "book_1", "title_1", "ספר מקור", "מקור"];
const TYPE_SYNONYMS = [CONNECTION_TYPE_KEY.toLowerCase(), "connection type", "connection_type", "type", "link_type", "סוג", "סוג קשר"];

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");
const pick = (fields: readonly string[], names: readonly string[]) => fields.find((f) => names.some((n) => norm(n) === norm(f)));

export function guessRecordsMapping(table: RecordsTable): RecordsMapping {
  const f = table.fields;
  const m: RecordsMapping = {
    source: pick(f, SOURCE_SYNONYMS) ? { field: pick(f, SOURCE_SYNONYMS)! } : { fromFileName: true },
    sourceLine: pick(f, SYNONYMS.sourceLine) ?? "",
    targetLine: pick(f, SYNONYMS.targetLine) ?? "",
    type: pick(f, TYPE_SYNONYMS) ? { field: pick(f, TYPE_SYNONYMS)! } : { fixed: "reference" },
    base: 1,
  };
  for (const k of ["sourceLineEnd", "targetTitle", "targetPath", "targetLineEnd", "heRef2", "start", "end"] as const) {
    const hit = pick(f, SYNONYMS[k]);
    if (hit) m[k] = hit;
  }
  // a file that counts from 0: some line value is 0 and none is negative
  const lines = table.rows.slice(0, 5000).flatMap((r) => [r[m.sourceLine], r[m.targetLine]]).filter((v): v is string => !!v && /^-?\d+$/.test(v));
  if (lines.some((v) => v === "0") && !lines.some((v) => v.startsWith("-"))) m.base = 0;
  return m;
}

/** What still has to be chosen before importing. */
export function mappingGaps(m: RecordsMapping): string[] {
  const gaps: string[] = [];
  if (!m.sourceLine) gaps.push("שורה בספר המקור");
  if (!m.targetLine) gaps.push("שורה בספר היעד");
  if (!m.targetTitle && !m.targetPath) gaps.push("ספר היעד (שם או נתיב)");
  if ("field" in m.source && !m.source.field) gaps.push("ספר המקור");
  if ("fixed" in m.source && !m.source.fixed.trim()) gaps.push("שם ספר המקור");
  if ("field" in m.type && !m.type.field) gaps.push("סוג הקשר");
  return gaps;
}

/* ---------------- converting ---------------- */

export interface RecordsConversion {
  /** per source title, a `_links.json` text to import (same shape as the CSV import) */
  files: { sourceTitle: string; text: string; rows: number }[];
  problems: string[];
}

export function recordsToLinksFiles(table: RecordsTable, m: RecordsMapping, fileName: string): RecordsConversion {
  const problems: string[] = [];
  const fromName = sourceTitleFromLinksFileName(fileName.replace(/\.(csv|tsv|jsonl?)$/i, ".json")) ?? fileName.replace(/\.[^.]+$/, "");
  const bySource = new Map<string, Record<string, unknown>[]>();
  const shift = m.base === 0 ? 1 : 0;
  const line = (row: Record<string, string>, field: string | undefined, r: number, what: string): number | undefined => {
    if (!field) return undefined;
    const v = row[field] ?? "";
    if (!v) return undefined;
    if (!/^-?\d+$/.test(v)) return void problems.push(`רשומה ${r}: ${what} "${v}" אינו מספר שלם.`);
    return Number(v) + shift;
  };
  table.rows.forEach((row, i) => {
    const r = i + 1;
    const source = "fromFileName" in m.source ? fromName : "fixed" in m.source ? m.source.fixed.trim() : (row[m.source.field] ?? "");
    if (!source) return void problems.push(`רשומה ${r}: ספר המקור ריק.`);
    const l1 = line(row, m.sourceLine, r, "שורת המקור");
    const l2 = line(row, m.targetLine, r, "שורת היעד");
    if (l1 === undefined || l2 === undefined) {
      // an invalid number was already reported by line(); an empty one is reported here
      for (const [v, f, what] of [[l1, m.sourceLine, "שורת המקור"], [l2, m.targetLine, "שורת היעד"]] as const) if (v === undefined && !row[f]) problems.push(`רשומה ${r}: חסרה ${what}.`);
      return;
    }
    const title = (m.targetTitle && row[m.targetTitle]) || "";
    const path = (m.targetPath && row[m.targetPath]) || (title ? `${title.replace(/\.txt$/i, "")}.txt` : "");
    if (!path) return void problems.push(`רשומה ${r}: ספר היעד ריק.`);
    const type = "fixed" in m.type ? m.type.fixed : (row[m.type.field] ?? "");
    const rec: Record<string, unknown> = { line_index_1: l1 };
    const l1e = line(row, m.sourceLineEnd, r, "סוף טווח המקור");
    if (l1e !== undefined) rec.line_index_1_end = l1e;
    rec.heRef_2 = (m.heRef2 && row[m.heRef2]) || path.replace(/\.txt$/i, "").split(/[\\/]/).at(-1)!;
    rec.path_2 = path;
    rec.line_index_2 = l2;
    const l2e = line(row, m.targetLineEnd, r, "סוף טווח היעד");
    if (l2e !== undefined) rec.line_index_2_end = l2e;
    for (const [k, f] of [["start", m.start], ["end", m.end]] as const) {
      const v = f ? row[f] : "";
      if (v && /^\d+$/.test(v)) rec[k] = Number(v);
    }
    rec[CONNECTION_TYPE_KEY] = type;
    let list = bySource.get(source);
    if (!list) bySource.set(source, (list = []));
    list.push(rec);
  });
  if (problems.length > 200) problems.splice(200, problems.length - 200, `ועוד ${problems.length - 200} בעיות.`);
  return { files: [...bySource].map(([sourceTitle, recs]) => ({ sourceTitle, text: JSON.stringify(recs, null, 2), rows: recs.length })), problems };
}
