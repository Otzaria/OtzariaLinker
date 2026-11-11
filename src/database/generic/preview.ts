import type { ColumnKind, ColumnPreview, SchemaPreview, TablePreview } from "../../core/db-mapping";
import type { SqlValue } from "../sqlite/lazy/record";
import type { SqliteFile, TableInfo } from "../sqlite/lazy/sqlite-file";
import { blobKind, GenericTextCodec } from "./text-codec";

/*
 * What the mapping wizard shows: every ordinary table with its columns (from the DDL), indexes, a
 * size measure, and a few sample rows. Bounded on every axis — tables, rows, characters per cell —
 * so a hostile or enormous database yields a small preview quickly.
 */
const MAX_TABLES = 200;
const SAMPLE_ROWS = 20;
export const SHOWN_ROWS = 5;
const CELL_CHARS = 160;
const HTML = /<\/?[a-z][a-z0-9]*(\s[^>]*)?>/i;

export async function previewSchema(file: SqliteFile): Promise<SchemaPreview> {
  const schema = await file.schema();
  const notes: string[] = [];
  const tables: TablePreview[] = [];
  const views = schema.filter((e) => e.type === "view").length;
  if (views) notes.push(`במסד ${views} מבטים (VIEW). הכלי קורא טבלאות בלבד; אם הספרים מורכבים ממבט, בחרו את הטבלאות שהוא קורא מהן.`);
  const virtual = schema.filter((e) => e.type === "table" && e.sql && /^\s*CREATE\s+VIRTUAL/i.test(e.sql)).map((e) => e.name);
  if (virtual.length) notes.push(`טבלאות וירטואליות (למשל אינדקס חיפוש FTS) אינן נקראות: ${virtual.slice(0, 5).join(", ")}${virtual.length > 5 ? "…" : ""}.`);
  if (file.header.wal) notes.push("המסד במצב WAL: שינויים שעדיין בקובץ ‎-wal שלידו לא ייראו.");

  const codec = new GenericTextCodec();
  for (const e of schema) {
    if (tables.length >= MAX_TABLES) {
      notes.push(`במסד יותר מ־${MAX_TABLES} טבלאות; מוצגות הראשונות בלבד.`);
      break;
    }
    if (e.type !== "table" || !e.sql || e.name.startsWith("sqlite_") || virtual.includes(e.name)) continue;
    let t: TableInfo | null;
    try {
      t = await file.table(e.name);
    } catch {
      notes.push(`לא הצלחתי לפענח את הגדרת הטבלה "${e.name}"; היא לא מוצגת.`);
      continue;
    }
    if (!t || !t.columns.length) continue;
    const rows: SqlValue[][] = [];
    for await (const r of file.scan(t)) {
      rows.push(r.values);
      if (rows.length >= SAMPLE_ROWS) break;
    }
    const columns = t.columns.map((c, i) => columnPreview(c.name, c.type, c.rowidAlias, rows.map((r) => r[i] ?? null), codec));
    for (const c of columns) {
      if (c.kind === "compressed") notes.push(`העמודה "${e.name}.${c.name}" מכילה טקסט דחוס (${c.compression}); הכלי פורס אותו בקריאה.`);
      if (c.kind === "binary") notes.push(`העמודה "${e.name}.${c.name}" מכילה נתונים בינאריים שאינם טקסט (למשל תמונה או דחיסה לא מוכרת); אי אפשר להציג אותם כטקסט.`);
    }
    tables.push({
      name: t.name,
      withoutRowid: t.withoutRowid,
      primaryKey: t.primaryKey,
      columns,
      indexes: (await file.indexesOf(t.name)).map((ix) => ({ name: ix.name, columns: ix.columns, seekable: ix.seekable })),
      samples: rows.slice(0, SHOWN_ROWS).map((r) => r.map((v, i) => display(v, columns[i]!.kind, codec))),
      pages: await file.leafCount(t.rootPage),
    });
  }
  return { fingerprint: fingerprintOf(schema.map((x) => `${x.type}|${x.name}|${x.tblName}|${x.sql ?? ""}`)), tables, notes };
}

function columnPreview(name: string, type: string, rowidAlias: boolean, values: SqlValue[], codec: GenericTextCodec): ColumnPreview {
  const filled = values.filter((v): v is Exclude<SqlValue, null> => v !== null && v !== "");
  const kinds = new Set<string>();
  let chars = 0;
  let texts = 0;
  let compression: string | undefined;
  for (const v of filled) {
    if (typeof v === "number" || typeof v === "bigint") kinds.add(Number.isInteger(Number(v)) ? "integer" : "real");
    else if (typeof v === "string") {
      kinds.add(HTML.test(v) ? "html" : "text");
      (chars += v.length), texts++;
    } else {
      const k = blobKind(v);
      if (k === "binary") kinds.add("binary");
      else {
        if (k !== "utf8") (compression = k), kinds.add("compressed");
        else kinds.add("text");
        try {
          const s = codec.decode(v) ?? "";
          (chars += s.length), texts++;
          if (HTML.test(s)) kinds.add("html");
        } catch {
          kinds.add("binary");
        }
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
  };
}

function display(v: SqlValue, kind: ColumnKind, codec: GenericTextCodec): string {
  if (v === null) return "NULL";
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
