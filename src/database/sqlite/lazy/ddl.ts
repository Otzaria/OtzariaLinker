/*
 * Column list of a CREATE TABLE statement, as stored in sqlite_master.sql.
 *
 * v3 split the column list on top-level commas without removing comments (TD-H5): in the real
 * seforim.db that renamed book.notesContent to "no" and link_range.endLineIndex to "for". This
 * tokenizer skips comments and string literals and understands table constraints.
 */
export interface ColumnDef {
  name: string;
  /** declared type, upper-cased, "" when none */
  type: string;
  /** true for an INTEGER PRIMARY KEY column — an alias of the rowid, stored as NULL in the record */
  rowidAlias: boolean;
  /** literal DEFAULT, used for rows written before an ALTER TABLE ADD COLUMN */
  defaultValue: null | number | string;
}

export interface TableDef {
  columns: ColumnDef[];
  withoutRowid: boolean;
  /** primary-key column names in key order (column-level or table-level), [] when none */
  primaryKey: string[];
}

type Tok = { kind: "word" | "str" | "num" | "punct"; text: string };

function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "-" && sql[i + 1] === "-") { const e = sql.indexOf("\n", i); i = e === -1 ? sql.length : e + 1; continue; }
    if (c === "/" && sql[i + 1] === "*") { const e = sql.indexOf("*/", i + 2); i = e === -1 ? sql.length : e + 2; continue; }
    if (c === "'" ) { const [text, next] = quoted(sql, i, "'"); out.push({ kind: "str", text }); i = next; continue; }
    if (c === '"' || c === "`") { const [text, next] = quoted(sql, i, c); out.push({ kind: "word", text }); i = next; continue; }
    if (c === "[") {
      // an unterminated [ used to reset i to 0 and loop forever (security review #3)
      const e = sql.indexOf("]", i);
      out.push({ kind: "word", text: sql.slice(i + 1, e === -1 ? sql.length : e) });
      i = e === -1 ? sql.length : e + 1;
      continue;
    }
    if (/[0-9.]/.test(c) || ((c === "-" || c === "+") && /[0-9.]/.test(sql[i + 1] ?? ""))) {
      const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(sql.slice(i))!;
      out.push({ kind: "num", text: m[0] }); i += m[0].length; continue;
    }
    if (/[A-Za-z_\u0080-￿]/.test(c)) {
      const m = /^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/.exec(sql.slice(i))!;
      out.push({ kind: "word", text: m[0] }); i += m[0].length; continue;
    }
    out.push({ kind: "punct", text: c }); i++;
  }
  return out;
}

/** A quoted literal or identifier; a doubled quote is an escaped quote. */
function quoted(sql: string, start: number, q: string): [string, number] {
  let text = "";
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === q) {
      if (sql[i + 1] === q) { text += q; i += 2; continue; }
      return [text, i + 1];
    }
    text += sql[i++];
  }
  return [text, i];
}

const TABLE_CONSTRAINT = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "CHECK", "FOREIGN"]);
const COLUMN_CONSTRAINT = new Set(["CONSTRAINT", "PRIMARY", "NOT", "NULL", "UNIQUE", "CHECK", "DEFAULT", "COLLATE", "REFERENCES", "GENERATED", "AS"]);

export function parseCreateTable(sql: string): TableDef {
  const toks = tokenize(sql);
  const open = toks.findIndex((t) => t.text === "(");
  if (open === -1) throw new Error("CREATE TABLE without a column list");
  // split the top-level list into definitions
  const defs: Tok[][] = [];
  let depth = 0;
  let cur: Tok[] = [];
  let close = toks.length;
  for (let i = open + 1; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.text === "(") depth++;
    if (t.text === ")") {
      if (depth === 0) { close = i; break; }
      depth--;
    }
    if (t.text === "," && depth === 0) { defs.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) defs.push(cur);
  const tail = toks.slice(close + 1).map((t) => t.text.toUpperCase());
  const withoutRowid = tail.includes("WITHOUT") && tail.includes("ROWID");

  const columns: ColumnDef[] = [];
  let primaryKey: string[] = [];
  let tableLevelPk = false;
  for (const d of defs) {
    const first = d[0];
    if (!first) continue;
    if (first.kind === "word" && TABLE_CONSTRAINT.has(first.text.toUpperCase()) && !isColumnNamedLikeKeyword(d)) {
      const words = d.map((t) => t.text.toUpperCase());
      const pk = words.findIndex((w, k) => w === "PRIMARY" && words[k + 1] === "KEY");
      if (pk !== -1) { primaryKey = keyColumns(d.slice(pk + 2)); tableLevelPk = true; }
      continue;
    }
    const col = parseColumn(d);
    columns.push(col);
    const words = d.map((t) => t.text.toUpperCase());
    if (words.some((w, k) => w === "PRIMARY" && words[k + 1] === "KEY")) primaryKey = [col.name];
  }
  // A table-level PRIMARY KEY (x) on a single INTEGER column is also a rowid alias (even with DESC;
  // only the column-level "INTEGER PRIMARY KEY DESC" form is not — handled in parseColumn).
  if (!withoutRowid && tableLevelPk && primaryKey.length === 1) {
    const c = columns.find((x) => x.name.toLowerCase() === primaryKey[0]!.toLowerCase());
    if (c && c.type === "INTEGER") c.rowidAlias = true;
  }
  if (withoutRowid) for (const c of columns) c.rowidAlias = false;
  return { columns, withoutRowid, primaryKey };
}

/** Column names inside "( a, b COLLATE x DESC )". */
function keyColumns(toks: Tok[]): string[] {
  const out: string[] = [];
  let depth = 0;
  let expectName = true;
  for (const t of toks) {
    if (t.text === "(") { depth++; if (depth === 1) expectName = true; continue; }
    if (t.text === ")") { depth--; if (depth === 0) break; continue; }
    if (depth === 1 && t.text === ",") { expectName = true; continue; }
    if (depth === 1 && expectName && t.kind === "word") { out.push(t.text); expectName = false; }
  }
  return out;
}

/** Index definition: target table and key columns, plus whether a simple ordered seek is valid. */
export interface IndexDef {
  table: string;
  columns: string[];
  /** false for expression keys, non-BINARY collation or DESC — those indexes are scanned, not seeked */
  seekable: boolean;
}

export function parseCreateIndex(sql: string): IndexDef {
  const toks = tokenize(sql);
  const on = toks.findIndex((t) => t.kind === "word" && t.text.toUpperCase() === "ON");
  const table = toks[on + 1]?.text ?? "";
  const rest = toks.slice(on + 2);
  const columns = keyColumns(rest);
  const close = rest.findIndex((t) => t.text === ")");
  const inner = rest.slice(1, close === -1 ? rest.length : close).map((t) => t.text.toUpperCase());
  const seekable = !inner.includes("DESC") && !inner.some((w, k) => w === "COLLATE" && inner[k + 1] !== "BINARY") && !inner.includes("(");
  return { table, columns, seekable };
}

/** `"primary" TEXT` is a column; `PRIMARY KEY (a, b)` is a constraint. */
function isColumnNamedLikeKeyword(d: Tok[]): boolean {
  const second = d[1]?.text.toUpperCase();
  const k = d[0]!.text.toUpperCase();
  if (k === "PRIMARY") return second !== "KEY";
  if (k === "FOREIGN") return second !== "KEY";
  if (k === "UNIQUE" || k === "CHECK") return second !== "(";
  if (k === "CONSTRAINT") return false;
  return true;
}

function parseColumn(d: Tok[]): ColumnDef {
  const name = d[0]!.text;
  const typeWords: string[] = [];
  let i = 1;
  while (i < d.length && d[i]!.kind === "word" && !COLUMN_CONSTRAINT.has(d[i]!.text.toUpperCase())) typeWords.push(d[i++]!.text.toUpperCase());
  if (d[i]?.text === "(") { while (i < d.length && d[i]!.text !== ")") i++; i++; } // VARCHAR(255)
  const type = typeWords.join(" ");
  const rest = d.slice(i).map((t) => t.text.toUpperCase());
  const pk = rest.findIndex((w, k) => w === "PRIMARY" && rest[k + 1] === "KEY");
  const desc = pk !== -1 && rest[pk + 2] === "DESC";
  const rowidAlias = type === "INTEGER" && pk !== -1 && !desc;
  let defaultValue: ColumnDef["defaultValue"] = null;
  const di = d.findIndex((t, k) => k >= i && t.kind === "word" && t.text.toUpperCase() === "DEFAULT");
  if (di !== -1) {
    let v = d[di + 1];
    if (v?.text === "(") v = d[di + 2];
    if (v?.kind === "num") defaultValue = Number(v.text);
    else if (v?.kind === "str") defaultValue = v.text;
  }
  return { name, type, rowidAlias, defaultValue };
}
