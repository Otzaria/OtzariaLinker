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
  /** declared collation, upper-cased ("BINARY" when none) — indexes on the column inherit it */
  collation: string;
  /**
   * GENERATED column: a "stored" value is in the record like any other; a "virtual" one is not in
   * the file at all (SQLite computes it on read), so it reads as NULL and must not be mapped.
   */
  generated: "virtual" | "stored" | null;
}

/** One key column of a PRIMARY KEY / UNIQUE constraint or of an index. */
export interface KeyPart {
  /** column name; for an expression key, the first word of the expression */
  name: string;
  /** explicit COLLATE of this key part, upper-cased; null = the column's own collation */
  collation: string | null;
  desc: boolean;
  /** the key is an expression, not a plain column */
  expr: boolean;
}

/** A PRIMARY KEY or UNIQUE constraint, column-level or table-level, in the order the DDL declares it. */
export interface KeyConstraint {
  primaryKey: boolean;
  parts: KeyPart[];
}

export interface TableDef {
  columns: ColumnDef[];
  withoutRowid: boolean;
  /** primary-key column names in key order (column-level or table-level), [] when none */
  primaryKey: string[];
  /** PRIMARY KEY and UNIQUE constraints in declaration order — they decide sqlite_autoindex numbering */
  constraints: KeyConstraint[];
  /**
   * The b-tree of a WITHOUT ROWID table is ordered by its primary key. It can be seeked only when
   * every key column compares BINARY and ascending (always true for a rowid table).
   */
  primaryKeySeekable: boolean;
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
  const constraints: KeyConstraint[] = [];
  let primaryKey: string[] = [];
  let tableLevelPk = false;
  for (const d of defs) {
    const first = d[0];
    if (!first) continue;
    if (first.kind === "word" && TABLE_CONSTRAINT.has(first.text.toUpperCase()) && !isColumnNamedLikeKeyword(d)) {
      const words = d.map((t) => t.text.toUpperCase());
      const pk = words.findIndex((w, k) => w === "PRIMARY" && words[k + 1] === "KEY");
      const uq = words.indexOf("UNIQUE");
      if (pk !== -1) {
        const parts = keyParts(d.slice(pk + 2));
        primaryKey = parts.map((x) => x.name);
        tableLevelPk = true;
        constraints.push({ primaryKey: true, parts });
      } else if (uq !== -1) constraints.push({ primaryKey: false, parts: keyParts(d.slice(uq + 1)) });
      continue;
    }
    const { col, keys } = parseColumn(d);
    columns.push(col);
    for (const k of keys) {
      if (k.primaryKey) primaryKey = [col.name];
      constraints.push({ primaryKey: k.primaryKey, parts: [{ name: col.name, collation: null, desc: k.desc, expr: false }] });
    }
  }
  // A table-level PRIMARY KEY (x) on a single INTEGER column is also a rowid alias (even with DESC;
  // only the column-level "INTEGER PRIMARY KEY DESC" form is not — handled in parseColumn).
  if (!withoutRowid && tableLevelPk && primaryKey.length === 1) {
    const c = columns.find((x) => x.name.toLowerCase() === primaryKey[0]!.toLowerCase());
    if (c && c.type === "INTEGER") c.rowidAlias = true;
  }
  if (withoutRowid) for (const c of columns) c.rowidAlias = false;
  const pkParts = constraints.find((k) => k.primaryKey)?.parts ?? [];
  const primaryKeySeekable = !withoutRowid || pkParts.every((k) => !k.desc && !k.expr && collationOf(columns, k) === "BINARY");
  return { columns, withoutRowid, primaryKey, constraints, primaryKeySeekable };
}

/** The collation a key part compares with: its own COLLATE, else its column's, else BINARY. */
export function collationOf(columns: readonly ColumnDef[], k: KeyPart): string {
  return k.collation ?? columns.find((c) => c.name.toLowerCase() === k.name.toLowerCase())?.collation ?? "BINARY";
}

/**
 * The key columns of sqlite_autoindex_<table>_<n>, at position n − 1. SQLite creates the automatic
 * indexes while it parses CREATE TABLE, one per PRIMARY KEY / UNIQUE constraint in declaration
 * order, each numbered after the indexes the table already has, except:
 *   - a PRIMARY KEY that is the rowid alias gets no index (and no number);
 *   - a constraint with the same columns and collations as an index already created is merged
 *     into it (no new index, no number), e.g. UNIQUE (a) next to PRIMARY KEY (a);
 *   - the PRIMARY KEY of a WITHOUT ROWID table takes a number but has no sqlite_master entry of
 *     its own: it is the table's b-tree.
 * (build.c: sqlite3AddPrimaryKey, sqlite3CreateIndex.) Review C12: assuming "#1 is the PK" made a
 * UNIQUE column declared before PRIMARY KEY (book, ord) read as the PK, and every book came out empty.
 */
export function autoIndexes(t: TableDef): KeyPart[][] {
  const out: KeyPart[][] = [];
  const same = (a: KeyPart[], b: KeyPart[]) =>
    a.length === b.length && a.every((k, i) => k.name.toLowerCase() === b[i]!.name.toLowerCase() && collationOf(t.columns, k) === collationOf(t.columns, b[i]!));
  for (const k of t.constraints) {
    const only = k.parts.length === 1 ? t.columns.find((c) => c.name.toLowerCase() === k.parts[0]!.name.toLowerCase()) : undefined;
    if (k.primaryKey && !t.withoutRowid && only?.rowidAlias) continue;
    if (out.some((x) => same(x, k.parts))) continue;
    out.push(k.parts);
  }
  return out;
}

/** Key parts inside "( a, b COLLATE x DESC, lower(c) )"; the tokens start at or before the "(". */
function keyParts(toks: Tok[]): KeyPart[] {
  const open = toks.findIndex((t) => t.text === "(");
  if (open === -1) return [];
  const items: Tok[][] = [[]];
  let depth = 0;
  for (const t of toks.slice(open + 1)) {
    if (t.text === ")" && depth === 0) break;
    if (t.text === "(") depth++;
    if (t.text === ")") depth--;
    if (t.text === "," && depth === 0) items.push([]);
    else items.at(-1)!.push(t);
  }
  return items.filter((it) => it.length).map((it): KeyPart => {
    const first = it[0]!;
    let expr = first.kind !== "word" || it[1]?.text === "(";
    let collation: string | null = null;
    let desc = false;
    for (let i = 1; i < it.length && !expr; i++) {
      const w = it[i]!.text.toUpperCase();
      if (w === "COLLATE" && it[i + 1]) collation = it[++i]!.text.toUpperCase();
      else if (w === "DESC") desc = true;
      else if (w !== "ASC") expr = true;
    }
    return { name: first.text, collation, desc, expr };
  });
}

/** Index definition: target table and key columns, plus whether a simple ordered seek is valid. */
export interface IndexDef {
  table: string;
  columns: string[];
  /**
   * The index can be seeked, and walked as an ordered list of every row: plain column keys, all
   * BINARY (their own COLLATE, else the column's) and ascending, and not partial. Anything else —
   * expression keys, NOCASE/RTRIM, DESC, a WHERE clause — is never used (review C12).
   */
  seekable: boolean;
}

/** An explicit CREATE INDEX: its key parts, and whether it is partial (has a WHERE). */
export function parseCreateIndex(sql: string): { table: string; parts: KeyPart[]; partial: boolean } {
  const toks = tokenize(sql);
  const on = toks.findIndex((t) => t.kind === "word" && t.text.toUpperCase() === "ON");
  const table = toks[on + 1]?.text ?? "";
  const rest = toks.slice(on + 2);
  let depth = 0;
  let close = rest.length;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i]!.text === "(") depth++;
    if (rest[i]!.text === ")" && --depth === 0) {
      close = i;
      break;
    }
  }
  const partial = rest.slice(close + 1).some((t) => t.kind === "word" && t.text.toUpperCase() === "WHERE");
  return { table, parts: keyParts(rest), partial };
}

/** Columns and seekability of an index with known key parts, resolved against its table. */
export function indexDef(table: string, parts: KeyPart[], partial: boolean, t: TableDef | null): IndexDef {
  const cols = t?.columns ?? [];
  const seekable = !partial && parts.length > 0 && parts.every((k) => !k.expr && !k.desc && collationOf(cols, k) === "BINARY");
  return { table, columns: parts.map((k) => k.name), seekable };
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

function parseColumn(d: Tok[]): { col: ColumnDef; keys: { primaryKey: boolean; desc: boolean }[] } {
  const name = d[0]!.text;
  const typeWords: string[] = [];
  let i = 1;
  while (i < d.length && d[i]!.kind === "word" && !COLUMN_CONSTRAINT.has(d[i]!.text.toUpperCase())) typeWords.push(d[i++]!.text.toUpperCase());
  if (d[i]?.text === "(") { while (i < d.length && d[i]!.text !== ")") i++; i++; } // VARCHAR(255)
  const type = typeWords.join(" ");
  // the constraints, top level only: an expression in DEFAULT, CHECK or AS may hold any word
  const top: Tok[] = [];
  let depth = 0;
  for (let k = i; k < d.length; k++) {
    const t = d[k]!;
    if (t.text === "(") {
      if (depth++ === 0) top.push(t);
    } else if (t.text === ")") depth--;
    else if (depth === 0) top.push(t);
  }
  const word = (k: number) => (top[k]?.kind === "word" ? top[k]!.text.toUpperCase() : "");
  const keys: { primaryKey: boolean; desc: boolean }[] = [];
  let collation = "BINARY";
  let generated: ColumnDef["generated"] = null;
  for (let k = 0; k < top.length; k++) {
    const w = word(k);
    if (w === "CONSTRAINT") k++; // its name
    else if (w === "PRIMARY" && word(k + 1) === "KEY") keys.push({ primaryKey: true, desc: word(k + 2) === "DESC" });
    else if (w === "UNIQUE") keys.push({ primaryKey: false, desc: false });
    else if (w === "COLLATE" && top[k + 1]) collation = top[++k]!.text.toUpperCase();
    else if (w === "AS" && top[k + 1]?.text === "(") generated = "virtual"; // GENERATED ALWAYS AS (…) [VIRTUAL]
    else if (generated && w === "STORED") generated = "stored";
  }
  const pk = keys.find((k) => k.primaryKey);
  const rowidAlias = type === "INTEGER" && !!pk && !pk.desc;
  let defaultValue: ColumnDef["defaultValue"] = null;
  const di = d.findIndex((t, k) => k >= i && t.kind === "word" && t.text.toUpperCase() === "DEFAULT");
  if (di !== -1) {
    let v = d[di + 1];
    if (v?.text === "(") v = d[di + 2];
    if (v?.kind === "num") defaultValue = Number(v.text);
    else if (v?.kind === "str") defaultValue = v.text;
  }
  return { col: { name, type, rowidAlias, defaultValue, collation, generated }, keys };
}
