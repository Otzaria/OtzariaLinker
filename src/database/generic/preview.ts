import type { ColumnKind, ColumnPreview, SchemaPreview, TablePreview, VirtualTablePreview } from "../../core/db-mapping";
import { jsonLines } from "../../core/db-text-units";
import type { SqlValue } from "../sqlite/lazy/record";
import type { SchemaEntry, SqliteFile, TableInfo } from "../sqlite/lazy/sqlite-file";
import { binaryFormat, blobKind, GenericTextCodec } from "./text-codec";

/*
 * What the mapping wizard shows: every ordinary table with its columns (from the DDL), indexes, a
 * size measure, and a few sample rows — plus what the guess ranks candidates by (core/db-guess.ts):
 * per column, statistics of the sampled values (Hebrew share, words, line breaks, JSON, encodings);
 * per database, the views and virtual tables the reader cannot read. Bounded on every axis —
 * tables, rows, characters per cell — so a hostile or enormous database yields a small preview quickly.
 */
const MAX_TABLES = 200;
const SAMPLE_ROWS = 20;
export const SHOWN_ROWS = 5;
const CELL_CHARS = 160;
/** characters of one value looked at for letters and words */
const STAT_CHARS = 4096;
/** a value longer than this is not parsed as JSON for the statistics */
const JSON_CHARS = 2 * 1024 ** 2;
/*
 * A tag. The attribute part stops at "<" too: with `[^>]*` a cell like "<a <a <a …" (no ">") made
 * every "<a" scan to the end of the cell — quadratic on sample cells read at open (security review
 * A6). Only the start of a cell is looked at; a cell that has markup has it early.
 */
const HTML = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?>/i;
const HTML_PROBE = 4096;
export const looksLikeHtml = (s: string): boolean => HTML.test(s.length > HTML_PROBE ? s.slice(0, HTML_PROBE) : s);

export async function previewSchema(file: SqliteFile): Promise<SchemaPreview> {
  const schema = await file.schema();
  const notes: string[] = [];
  const tables: TablePreview[] = [];
  const virtualTables = schema.filter((e) => e.type === "table" && e.sql && /^\s*CREATE\s+VIRTUAL/i.test(e.sql)).map(virtualTable);
  const shadows = shadowTables(virtualTables);
  if (file.header.wal) notes.push("המסד במצב WAL: שינויים שעדיין בקובץ ‎-wal שלידו לא ייראו.");

  const codec = new GenericTextCodec();
  for (const e of schema) {
    if (tables.length >= MAX_TABLES) {
      notes.push(`במסד יותר מ־${MAX_TABLES} טבלאות; מוצגות הראשונות בלבד.`);
      break;
    }
    if (e.type !== "table" || !e.sql || e.name.startsWith("sqlite_") || virtualTables.some((v) => v.name === e.name)) continue;
    let t: TableInfo | null;
    try {
      t = await file.table(e.name);
    } catch {
      notes.push(`לא הצלחתי לפענח את הגדרת הטבלה "${e.name}"; היא לא מוצגת.`);
      continue;
    }
    if (!t || !t.columns.length) continue;
    const rows: SqlValue[][] = [];
    const rowids: number[] = [];
    for await (const r of file.scan(t)) {
      rows.push(r.values);
      if (r.rowid !== null) rowids.push(r.rowid);
      if (rows.length >= SAMPLE_ROWS) break;
    }
    const columns = t.columns.map((c, i) => ({
      ...columnPreview(c.name, c.type, c.rowidAlias, rows.map((r) => r[i] ?? null), codec),
      ...(c.generated === "virtual" && { virtual: true }),
    }));
    const virtualCols = t.columns.filter((c) => c.generated === "virtual").map((c) => c.name);
    if (virtualCols.length) notes.push(`בטבלה "${e.name}" עמודות מחושבות (GENERATED … VIRTUAL) שאינן שמורות בקובץ ולכן אינן נקראות: ${virtualCols.join(", ")}.`);
    for (const c of columns) {
      if (c.kind === "compressed") notes.push(`העמודה "${e.name}.${c.name}" מכילה טקסט דחוס (${c.compression}); הכלי פורס אותו בקריאה.`);
      if (c.encoding) notes.push(`העמודה "${e.name}.${c.name}" מכילה טקסט בקידוד ${ENCODING_LABEL[c.encoding]} בתוך BLOB; הכלי מפענח אותו בקריאה.`);
      if (c.kind === "binary")
        notes.push(
          c.format
            ? `העמודה "${e.name}.${c.name}" מכילה ${c.format}. הכלי אינו קורא את הפורמט הזה כטקסט.`
            : `העמודה "${e.name}.${c.name}" מכילה נתונים בינאריים שאינם טקסט (למשל תמונה או דחיסה לא מוכרת); אי אפשר להציג אותם כטקסט.`,
        );
    }
    const shadow = shadows.get(t.name.toLowerCase());
    const fks = t.foreignKeys.filter((f) => f.columns.length === 1).map((f) => ({ column: f.columns[0]!, table: f.table }));
    tables.push({
      name: t.name,
      withoutRowid: t.withoutRowid,
      primaryKey: t.primaryKey,
      ...(t.withoutRowid && { primaryKeySeekable: t.primaryKeySeekable }),
      columns,
      indexes: (await file.indexesOf(t.name)).map((ix) => ({ name: ix.name, columns: ix.columns, seekable: ix.seekable })),
      samples: rows.slice(0, SHOWN_ROWS).map((r) => r.map((v, i) => display(v, columns[i]!.kind, codec))),
      pages: await file.leafCount(t.rootPage),
      ...(rowids.length && { rowids }),
      ...(fks.length && { foreignKeys: fks }),
      ...(shadow && { shadowOf: shadow }),
    });
  }
  const views = schema.filter((e) => e.type === "view").map((e) => ({ name: e.name, reads: readsOf(e, tables) }));
  return {
    fingerprint: fingerprintOf(schema.map((x) => `${x.type}|${x.name}|${x.tblName}|${x.sql ?? ""}`)),
    tables,
    notes,
    ...(views.length && { views }),
    ...(virtualTables.length && { virtualTables }),
  };
}

const ENCODING_LABEL = { utf16le: "UTF-16", utf16be: "UTF-16 (big-endian)", cp1255: "Windows-1255" } as const;

const FTS_OPTION = /^[A-Za-z_]+\s*=/;

/** "CREATE VIRTUAL TABLE docs USING fts5(title, body, content='')" → its module, columns and content option. */
function virtualTable(e: SchemaEntry): VirtualTablePreview {
  const m = /USING\s+([A-Za-z0-9_]+)\s*(?:\(([\s\S]*)\))?\s*;?\s*$/i.exec(e.sql ?? "");
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of m?.[2] ?? "") {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  const content = args.find((a) => /^content\s*=/i.test(a))?.replace(/^[^=]*=\s*/, "").replace(/^['"]|['"]$/g, "");
  return {
    name: e.name,
    module: (m?.[1] ?? "").toLowerCase(),
    columns: args.filter((a) => !FTS_OPTION.test(a)).map((a) => a.split(/\s+/)[0]!.replace(/^["'`[]|["'`\]]$/g, "")),
    content: content === undefined ? "stored" : content === "" ? "none" : "external",
  };
}

/** The storage tables SQLite's FTS and R-tree modules create next to a virtual table. */
const SHADOW_SUFFIXES = ["content", "data", "idx", "docsize", "config", "segments", "segdir", "stat", "node", "parent", "rowid"];
function shadowTables(virtual: VirtualTablePreview[]): Map<string, { table: string; module: string }> {
  const out = new Map<string, { table: string; module: string }>();
  for (const v of virtual) for (const s of SHADOW_SUFFIXES) out.set(`${v.name}_${s}`.toLowerCase(), { table: v.name, module: v.module });
  return out;
}

/** The tables a view's SQL names (by whole word; a hint, not a parse). */
function readsOf(e: SchemaEntry, tables: TablePreview[]): string[] {
  const words = new Set((e.sql ?? "").toLowerCase().split(/[^\p{L}\p{N}_$]+/u));
  return tables.filter((t) => words.has(t.name.toLowerCase())).map((t) => t.name);
}

const HEBREW = /[א-ת]/g;
const LETTER = /\p{L}/gu;
const TIMESTAMP = /^\s*(\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?|\d{1,2}[./]\d{1,2}[./]\d{2,4}( \d{1,2}:\d{2})?|\d{2}:\d{2}(:\d{2})?)/;

function columnPreview(name: string, type: string, rowidAlias: boolean, values: SqlValue[], codec: GenericTextCodec): ColumnPreview {
  const filled = values.filter((v): v is Exclude<SqlValue, null> => v !== null && v !== "");
  const kinds = new Set<string>();
  let chars = 0;
  let texts = 0;
  let compression: string | undefined;
  let encoding: ColumnPreview["encoding"];
  let format: string | undefined;
  const strings: string[] = [];
  const ints = new Set<number>();
  for (const v of filled) {
    if (typeof v === "number" || typeof v === "bigint") {
      const isInt = Number.isInteger(Number(v));
      kinds.add(isInt ? "integer" : "real");
      if (isInt && ints.size < 20) ints.add(Number(v));
    } else if (typeof v === "string") {
      kinds.add(looksLikeHtml(v) ? "html" : "text");
      chars += v.length;
      texts++;
      strings.push(v);
    } else {
      const k = blobKind(v);
      if (k === "binary") {
        kinds.add("binary");
        format ??= binaryFormat(v) ?? undefined;
        continue;
      }
      if (k === "utf16le" || k === "utf16be" || k === "cp1255") encoding = k;
      if (k === "zstd" || k === "gzip" || k === "zlib") {
        compression = k;
        kinds.add("compressed");
      } else kinds.add("text");
      try {
        const s = codec.decode(v) ?? "";
        chars += s.length;
        texts++;
        strings.push(s);
        if (looksLikeHtml(s)) kinds.add("html");
      } catch {
        kinds.add("binary");
        // a frame that needs a dictionary the database does not hold (Otzaria's schema 6–7 keeps it in zstd_dict)
        if (k === "zstd") format ??= "טקסט דחוס ב־zstd שצריך מילון דחיסה (הכלי אינו מוצא אותו במסד)";
      }
    }
  }
  const kind: ColumnKind = rowidAlias
    ? "integer"
    : kinds.has("binary")
      ? "binary"
      : kinds.has("compressed")
        ? "compressed"
        : kinds.has("html")
          ? "html"
          : kinds.has("text")
            ? "text"
            : kinds.has("real")
              ? "real"
              : kinds.has("integer")
                ? "integer"
                : "empty";
  return {
    name,
    type,
    rowidAlias,
    kind,
    avgLength: texts ? Math.round(chars / texts) : 0,
    distinct: new Set(filled.map((v) => (v instanceof Uint8Array ? `b${v.length}:${v.slice(0, 16).join(",")}` : String(v)))).size,
    filled: filled.length,
    ...(compression && { compression }),
    ...(encoding && { encoding }),
    ...(kind === "binary" && format && { format }),
    ...(kind === "integer" && ints.size && { ints: [...ints] }),
    ...(kind !== "binary" && strings.length && textStats(strings)),
  };
}

/** Statistics of the text values of a column (see ColumnPreview). */
function textStats(strings: string[]): Partial<ColumnPreview> {
  let letters = 0;
  let hebrew = 0;
  let words = 0;
  let newlines = 0;
  let garbled = 0;
  let stamps = 0;
  let jsonTotal = 0;
  let jsonCount = 0;
  const lengths = new Map<number, number>();
  for (const raw of strings) {
    lengths.set(raw.length, (lengths.get(raw.length) ?? 0) + 1);
    if (raw.includes("�")) garbled++;
    if (TIMESTAMP.test(raw)) stamps++;
    let s = raw;
    const j = raw.length <= JSON_CHARS ? jsonLines(raw) : null;
    if (j) {
      jsonTotal += j.length;
      jsonCount++;
      s = j.slice(0, 200).map((l) => l.text).join(" ");
    } else for (let i = raw.indexOf("\n"); i !== -1; i = raw.indexOf("\n", i + 1)) newlines++;
    const probe = (s.length > STAT_CHARS ? s.slice(0, STAT_CHARS) : s).replace(/<[^<>]*>/g, " ");
    letters += probe.match(LETTER)?.length ?? 0;
    hebrew += probe.match(HEBREW)?.length ?? 0;
    const trimmed = probe.trim();
    words += trimmed ? trimmed.split(/\s+/).length : 0;
  }
  const n = strings.length;
  const mode = Math.max(...lengths.values());
  return {
    ...(letters && { hebrew: Math.round((hebrew / letters) * 100) / 100 }),
    words: Math.round((words / n) * 10) / 10,
    newlines: Math.round((newlines / n) * 10) / 10,
    ...(n >= 3 && { sameLength: Math.round((mode / n) * 100) / 100 }),
    ...(jsonCount >= n / 2 && { jsonLines: Math.round((jsonTotal / jsonCount) * 10) / 10 }),
    ...(garbled && { garbled: Math.round((garbled / n) * 100) / 100 }),
    ...(stamps >= n * 0.8 && { timestamps: true }),
  };
}

function display(v: SqlValue, kind: ColumnKind, codec: GenericTextCodec): string {
  if (v === null) return "";
  if (typeof v === "string") return clip(v);
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (kind === "binary") return `‹${v.length} בתים›`;
  try {
    return clip(codec.decode(v) ?? "");
  } catch {
    return `‹${v.length} בתים›`;
  }
}

const clip = (s: string) => (s.length > CELL_CHARS ? `${s.slice(0, CELL_CHARS)}…` : s);

/** Two 32-bit FNV-style hashes over the sorted schema entries: stable, independent of entry order. */
export function fingerprintOf(entries: string[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (const e of [...entries].sort()) {
    for (let i = 0; i < e.length; i++) {
      const c = e.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    h1 = Math.imul(h1 ^ 0x0a, 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}
