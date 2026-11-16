/*
 * Mapping an arbitrary SQLite database of books (not Otzaria's schema) onto books and lines — the
 * "universal sources" requirement. The worker reads the schema and sample rows (SchemaPreview), the
 * user confirms or corrects a guessed DbMapping in a wizard, and the worker then reads the database
 * through it. Everything here is plain data and pure functions, so the state and UI layers can hold,
 * check and save a mapping without depending on the database layer.
 */

/** A pseudo-column: SQLite's rowid (or the INTEGER PRIMARY KEY column that aliases it). */
export const ROWID = "@rowid";

/** What the sample values of a column look like. */
export type ColumnKind = "integer" | "real" | "text" | "html" | "compressed" | "binary" | "empty";

export interface ColumnPreview {
  name: string;
  /** declared type, upper-cased ("" when none) */
  type: string;
  rowidAlias: boolean;
  kind: ColumnKind;
  /** average length of the non-empty text samples (characters; decoded size for compressed values) */
  avgLength: number;
  /** distinct non-null sample values */
  distinct: number;
  /** non-null samples */
  filled: number;
  /** e.g. "zstd", "gzip", "zlib" for compressed values */
  compression?: string;
  /** a GENERATED … VIRTUAL column: not stored in the file, so it cannot be read or mapped */
  virtual?: boolean;
  /*
   * Statistics of the sampled values, for ranking the candidates (db-guess.ts). All optional: a
   * preview made by an older build, or a hand-made one in a test, simply has no evidence of that kind.
   */
  /** share of the letters that are Hebrew (0–1); absent when the samples have no letters */
  hebrew?: number;
  /** average words per value */
  words?: number;
  /** average line breaks per value: a whole book, a chapter or a chunk in one cell */
  newlines?: number;
  /** share of the values that have the most common length: fixed-size chunks of one text */
  sameLength?: number;
  /** the values are JSON arrays/objects of text: the average number of lines they flatten to */
  jsonLines?: number;
  /** BLOB text in an encoding other than UTF-8 */
  encoding?: "utf16le" | "utf16be" | "cp1255";
  /** share of the values with U+FFFD: TEXT that is not valid UTF-8 (a legacy code page stored as TEXT) */
  garbled?: number;
  /** most values look like dates or times */
  timestamps?: boolean;
  /** integer columns: the distinct sampled values (at most 20), to see which table a column refers to */
  ints?: number[];
  /** binary columns: a recognised non-text format ("תמונת PNG", "דחיסת bzip2") */
  format?: string;
}

export interface IndexPreview {
  name: string;
  columns: string[];
  /** false for DESC / non-BINARY collation / expression keys: the reader cannot seek it */
  seekable: boolean;
}

export interface TablePreview {
  name: string;
  withoutRowid: boolean;
  primaryKey: string[];
  /** WITHOUT ROWID only: false when the key is not BINARY ascending (NOCASE, DESC…), so it cannot be read */
  primaryKeySeekable?: boolean;
  columns: ColumnPreview[];
  indexes: IndexPreview[];
  /** the first rows, as short display strings aligned to `columns` */
  samples: string[][];
  /** leaf pages of the table's b-tree: a cheap measure of its size */
  pages: number;
  /** rowids of the sampled rows (rowid tables), to see which table a column refers to */
  rowids?: number[];
  /** declared FOREIGN KEYs of single columns (a hint for the guess) */
  foreignKeys?: { column: string; table: string }[];
  /** an internal table of a virtual table (FTS index storage, R-tree nodes): `docs_content` of `docs` */
  shadowOf?: { table: string; module: string };
}

/** A virtual table (FTS, R-tree…): only SQLite's module can read it; its storage tables may be ordinary tables. */
export interface VirtualTablePreview {
  name: string;
  /** "fts5", "fts4", "rtree"… lower-cased */
  module: string;
  /** declared column names (FTS: the text columns, stored as c0, c1… in `<name>_content`) */
  columns: string[];
  /** FTS with content='' (no text kept) or content=<other table> (the text is elsewhere) */
  content: "stored" | "none" | "external";
}

export interface SchemaPreview {
  /** identifies the schema (hash of sqlite_master): the same schema reuses a saved mapping */
  fingerprint: string;
  tables: TablePreview[];
  /** what else was seen (compressed or binary columns, WAL…), in Hebrew */
  notes: string[];
  /** VIEWs, with the tables their SQL names: the reader reads b-trees, and a view has none */
  views?: { name: string; reads: string[] }[];
  virtualTables?: VirtualTablePreview[];
}

export interface DbMapping {
  /** "two-tables": a books table and a lines table; "single-table": one row per line, a column holds the book title */
  layout: "two-tables" | "single-table";
  /** two-tables only */
  books?: { table: string; id: string; title: string; path?: string; category?: string };
  lines: {
    table: string;
    /** two-tables: the column that refers to books.id; single-table: the column that holds the book title */
    book: string;
    /** the order of lines inside a book (any sortable column, or ROWID) */
    order: string;
    text: string;
    /** optional heading level (1–6; anything else = not a heading) */
    heading?: string;
    /** single-table only: a path/category shown next to the title */
    path?: string;
    /** more order columns after `order`, for a composite key: (chapter, verse) → order "chapter", orderThen ["verse"] */
    orderThen?: string[];
    /**
     * How a row's text becomes lines (default "line"):
     *   "line"   one row = one line;
     *   "lines"  a row holds several lines separated by line breaks (a whole book, or a chapter, per row);
     *   "chunks" the rows of a book are consecutive pieces of one text: joined, then split at line breaks;
     *   "json"   a row holds JSON: an array of lines, of chapters (arrays), or of {title, verses} objects.
     */
    unit?: TextUnit;
  };
  /**
   * two-tables only: the lines refer to a row of an intermediate table, which refers to the book.
   * "part": chapters — a book's lines in (part order, line order); "edition": versions — every row of
   * this table is a book of its own, titled "<book> — <title>".
   */
  via?: { table: string; id: string; book: string; order?: string; title?: string; kind: "part" | "edition" };
  /** optional: an existing links table whose two columns hold line ids (the lines table's rowid) */
  links?: { table: string; source: string; target: string; type?: string };
}

export type TextUnit = "line" | "lines" | "chunks" | "json";

/** Why the wizard guessed what it guessed — or why it found no books (db-guess.ts). */
export interface CandidateReason {
  /** points for (> 0) or against (< 0) this column holding book text; 0 = a plain fact */
  weight: number;
  text: string;
}

export interface TextCandidate {
  table: string;
  column: string;
  /** the sum of the reasons' weights; ≥ BOOKS_SCORE is proposed */
  score: number;
  verdict: "books" | "weak" | "rejected";
  reasons: CandidateReason[];
  /** what to check before trusting this candidate */
  warnings: string[];
  /** the mapping this candidate gives, or null when its rows could not be grouped into books */
  mapping: DbMapping | null;
}

export interface DbAnalysis {
  /** the best candidates first (at most 8) */
  candidates: TextCandidate[];
  /** the mapping proposed to the user: the best "books" candidate, or null */
  guess: DbMapping | null;
  /** nothing in the database looks like book text */
  noBooks: boolean;
  /** one sentence: what was found, or why nothing was */
  summary: string;
  /** what the tool cannot read in this database (views, virtual tables, encodings…), in Hebrew */
  limitations: string[];
}

/** First lines of the first books, read through a mapping before it is confirmed ("בדיקת המיפוי"). */
export interface MappingTest {
  /** books found (in the part read, when `partial`) */
  books: number;
  /** the test read only the beginning of a large table */
  partial: boolean;
  sample: { title: string; lineCount: number | null; lines: { text: string; heading: number | null }[] }[];
  warnings: string[];
  /** lines whose text could not be decoded (shown empty) */
  undecodable: number;
}

/** A database that needs a mapping before it can be opened (returned by the open operation). */
export interface PendingDb {
  /** handle for the worker's openMapped operation */
  token: string;
  path: string;
  label: string;
  preview: SchemaPreview;
  /** the automatic guess, or null when nothing plausible was found */
  guess: DbMapping | null;
  /** why the guess (ranked candidates, reasons, limitations); absent in entries made before it existed */
  analysis?: DbAnalysis;
}

/** A mapping remembered for a schema, kept in the project file. */
export interface SavedDbMapping {
  fingerprint: string;
  label: string;
  mapping: DbMapping;
}

export interface MappingProblem {
  level: "error" | "warning" | "info";
  message: string;
}

const TEXTUAL = new Set<ColumnKind>(["text", "html", "compressed"]);

/** A mapped GENERATED … VIRTUAL column: its value is not in the file (review C12). */
export const virtualColumnMessage = (table: string, column: string): string =>
  `העמודה "${column}" בטבלה "${table}" מחושבת (GENERATED … VIRTUAL): הערך שלה אינו שמור בקובץ, ו־SQLite מחשב אותו רק בשאילתה. הכלי קורא את הקובץ ישירות ואינו יכול לחשב אותו. בחרו את העמודה שממנה היא מחושבת.`;

/** A WITHOUT ROWID lines table whose key is not BINARY ascending cannot be searched by key (review C12). */
export const unsortedKeyMessage = (table: string): string =>
  `המפתח הראשי של הטבלה "${table}" ממוין בסדר שהכלי לא יודע לחפש בו (COLLATE NOCASE או אחר, או DESC). הכלי קורא טבלת WITHOUT ROWID רק לפי מפתח רגיל (BINARY, בסדר עולה), ולכן אינו פותח אותה, כדי לא להציג ספרים עם שורות חסרות.`;

/** Checks a mapping against the schema. Errors block opening; warnings and info explain. */
export function mappingProblems(preview: SchemaPreview, m: DbMapping): MappingProblem[] {
  const out: MappingProblem[] = [];
  const err = (message: string) => out.push({ level: "error", message });
  const table = (name: string | undefined, role: string): TablePreview | null => {
    if (!name) return err(`בחרו טבלה ל${role}.`), null;
    const t = preview.tables.find((x) => x.name === name);
    if (!t) err(`הטבלה "${name}" אינה קיימת במסד.`);
    return t ?? null;
  };
  const column = (t: TablePreview, name: string | undefined, role: string, opts: { rowid?: boolean; optional?: boolean } = {}): ColumnPreview | "rowid" | null => {
    if (!name) {
      if (!opts.optional) err(`בחרו עמודה ל${role} (בטבלה "${t.name}").`);
      return null;
    }
    if (name === ROWID) {
      if (!opts.rowid) return err(`ל${role} צריך לבחור עמודה, לא את מספר הרשומה.`), null;
      if (t.withoutRowid) return err(`לטבלה "${t.name}" אין rowid (WITHOUT ROWID). בחרו עמודה ל${role}.`), null;
      return "rowid";
    }
    const c = t.columns.find((x) => x.name === name);
    if (!c) return err(`העמודה "${name}" אינה קיימת בטבלה "${t.name}".`), null;
    if (c.virtual) return err(virtualColumnMessage(t.name, name)), null;
    return c;
  };

  const lines = table(m.lines.table, "השורות");
  let books: TablePreview | null = null;
  if (m.layout === "two-tables") {
    books = table(m.books?.table, "הספרים");
    if (books) {
      column(books, m.books!.id, "מזהה הספר", { rowid: true });
      const title = column(books, m.books!.title, "שם הספר");
      if (title && title !== "rowid" && !TEXTUAL.has(title.kind) && title.kind !== "empty")
        out.push({ level: "warning", message: `העמודה "${title.name}" אינה נראית כמו טקסט; שמות הספרים יוצגו כמו שהם.` });
      column(books, m.books!.path, "נתיב", { optional: true });
      column(books, m.books!.category, "קטגוריה", { optional: true });
    }
    if (books && lines && books.name === lines.name) err("טבלת הספרים וטבלת השורות הן אותה טבלה. אם כל שורה מחזיקה את שם הספר, בחרו \"טבלה אחת\".");
  }
  const unit = m.lines.unit ?? "line";
  const then = m.lines.orderThen ?? [];
  if (lines) {
    column(lines, m.lines.book, m.layout === "two-tables" ? (m.via ? "הפרק או המהדורה של כל שורה" : "הספר של כל שורה") : "שם הספר");
    const order = column(lines, m.lines.order, "סדר השורות", { rowid: true });
    for (const c of then) column(lines, c, "סדר משני");
    if (then.length && m.lines.order === ROWID) err("סדר משני בא אחרי עמודת סדר. בחרו עמודה לסדר השורות (לא את סדר הרשומות).");
    const text = column(lines, m.lines.text, "טקסט השורה");
    column(lines, m.lines.heading, "רמת כותרת", { optional: true });
    if (m.layout === "single-table") column(lines, m.lines.path, "נתיב", { optional: true });
    if (text && text !== "rowid") {
      if (text.kind === "binary") err(`העמודה "${text.name}" מכילה ${text.format ?? "נתונים בינאריים שאינם טקסט"}, ואי אפשר להציג אותם כטקסט.`);
      else if (text.kind === "integer" || text.kind === "real") out.push({ level: "warning", message: `העמודה "${text.name}" מכילה מספרים. האם זו באמת עמודת הטקסט?` });
      else if (text.kind === "empty") out.push({ level: "warning", message: `בשורות הראשונות העמודה "${text.name}" ריקה.` });
      if ((text.garbled ?? 0) > 0.2) out.push({ level: "warning", message: garbledMessage(lines.name, text.name) });
      if (unit === "line" && (text.jsonLines ?? 0) > 1)
        out.push({ level: "info", message: `הערכים בעמודה "${text.name}" הם JSON (כ־${Math.round(text.jsonLines!)} שורות בכל ערך). כדי לקרוא אותם כשורות, בחרו "JSON" ביחידת הטקסט.` });
      else if (unit === "line" && (text.newlines ?? 0) >= 1)
        out.push({ level: "info", message: `בכל ערך בעמודה "${text.name}" יש בממוצע ${Math.round(text.newlines! + 1)} שורות. אם כל רשומה היא ספר, פרק או קטע של טקסט, בחרו את יחידת הטקסט המתאימה.` });
      if (unit === "json" && text.jsonLines === undefined && text.kind !== "empty") out.push({ level: "warning", message: `הערכים בעמודה "${text.name}" אינם נראים כמו JSON בשורות הראשונות.` });
    }
    if (unit !== "line" && m.lines.heading) out.push({ level: "info", message: "כשרשומה מחזיקה כמה שורות, עמודת רמת הכותרת אינה בשימוש: כותרות מזוהות לפי <h1>–<h6> בטקסט." });
    if (lines.withoutRowid && order) {
      const pk = lines.primaryKey.map((x) => x.toLowerCase());
      const want = [m.lines.book, m.lines.order, ...then].map((x) => x.toLowerCase());
      if (want.some((x, i) => pk[i] !== x))
        err(`הטבלה "${lines.name}" היא WITHOUT ROWID, והכלי קורא אותה רק כשהמפתח הראשי שלה מתחיל ב(${[m.lines.book, m.lines.order, ...then].join(", ")}).`);
      else if (lines.primaryKeySeekable === false) err(unsortedKeyMessage(lines.name));
      if (m.via) err(withoutRowidViaMessage(lines.name));
    }
    if (!out.some((p) => p.level === "error")) {
      if (m.via) out.push({ level: "info", message: `עם טבלת ביניים ("${m.via.table}") הכלי קורא בפתיחה את טבלת השורות פעם אחת מתחילתה ועד סופה. במסד גדול זה ייקח זמן (אפשר לבטל).` });
      else if (!lines.withoutRowid && !hasSeekableIndex(lines, m.lines.book))
        out.push({
          level: "info",
          message: `אין בטבלה "${lines.name}" אינדקס לפי ${m.layout === "two-tables" ? "ספר" : "שם הספר"}, ולכן בפתיחה הכלי יקרא אותה פעם אחת מתחילתה ועד סופה ויבנה אינדקס בזיכרון. במסד גדול זה ייקח זמן (אפשר לבטל).`,
        });
    }
  }
  if (m.via) {
    if (m.layout !== "two-tables") err("טבלת פרקים או מהדורות אפשרית רק עם טבלת ספרים וטבלת שורות.");
    const vt = table(m.via.table, "הפרקים או המהדורות");
    if (vt) {
      column(vt, m.via.id, "מזהה הפרק או המהדורה", { rowid: true });
      column(vt, m.via.book, "הספר של הפרק או המהדורה");
      column(vt, m.via.order, "סדר הפרקים", { rowid: true, optional: true });
      column(vt, m.via.title, "שם הפרק או המהדורה", { optional: true });
      if (vt.name === lines?.name || vt.name === books?.name) err("טבלת הפרקים או המהדורות צריכה להיות טבלה שלישית, לא טבלת הספרים או השורות.");
    }
  }
  if (m.links) {
    const lt = table(m.links.table, "הקישורים");
    if (lt) {
      column(lt, m.links.source, "שורת המקור");
      column(lt, m.links.target, "שורת היעד");
      column(lt, m.links.type, "סוג הקישור", { optional: true });
    }
    if (lines?.withoutRowid) err("קישורים נקראים לפי מזהה השורה (rowid), ולטבלת השורות אין rowid.");
    if (unit !== "line") err("קישורים נקראים לפי מזהה השורה (rowid), ובמיפוי הזה רשומה אינה שורה אחת. הסירו את טבלת הקישורים או בחרו \"כל רשומה היא שורה\".");
  }
  return out;
}

/** WITHOUT ROWID lines are sought by (book, order…); through a chapters table the "book" of a line is its chapter. */
export const withoutRowidViaMessage = (table: string): string =>
  `טבלת השורות "${table}" היא WITHOUT ROWID, והכלי אינו קורא טבלה כזאת דרך טבלת פרקים או מהדורות. אפשר למפות את הפרקים או המהדורות עצמם כספרים.`;

/** TEXT that is not valid UTF-8: SQLite keeps the bytes, but they reach the tool already replaced by U+FFFD. */
export const garbledMessage = (table: string, column: string): string =>
  `בעמודה "${table}.${column}" יש טקסט שאינו UTF-8 תקין — כנראה קידוד ישן (Windows-1255 או DOS) שנשמר כ־TEXT. הכלי אינו יכול לשחזר את האותיות מעמודת TEXT, והן יוצגו כסימני שאלה. (אותו טקסט בעמודת BLOB כן נקרא.)`;

export const hasSeekableIndex = (t: TablePreview, firstColumn: string): boolean =>
  t.indexes.some((ix) => ix.seekable && ix.columns[0]?.toLowerCase() === firstColumn.toLowerCase());

/* ---------------- reading a mapping back from untrusted JSON ---------------- */

const UNITS = ["line", "lines", "chunks", "json"] as const;
const s = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 256;
const opt = (o: Record<string, unknown>, k: string) => (s(o[k]) ? { [k]: o[k] as string } : {});

/** Rebuilds a mapping field by field from untrusted data (a project file); null when it is not one. */
export function parseDbMapping(x: unknown): DbMapping | null {
  const m = x as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || (m.layout !== "two-tables" && m.layout !== "single-table")) return null;
  const l = m.lines as Record<string, unknown> | null;
  if (!l || typeof l !== "object" || !s(l.table) || !s(l.book) || !s(l.order) || !s(l.text)) return null;
  const then = Array.isArray(l.orderThen) ? l.orderThen.filter(s).slice(0, 4) : [];
  const unit = typeof l.unit === "string" && (UNITS as readonly string[]).includes(l.unit) && l.unit !== "line" ? (l.unit as TextUnit) : undefined;
  const lines = {
    table: l.table,
    book: l.book,
    order: l.order,
    text: l.text,
    ...opt(l, "heading"),
    ...(m.layout === "single-table" ? opt(l, "path") : {}),
    ...(then.length && { orderThen: then }),
    ...(unit && { unit }),
  };
  let books: DbMapping["books"];
  if (m.layout === "two-tables") {
    const b = m.books as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || !s(b.table) || !s(b.id) || !s(b.title)) return null;
    books = { table: b.table, id: b.id, title: b.title, ...opt(b, "path"), ...opt(b, "category") };
  }
  let links: DbMapping["links"];
  const k = m.links as Record<string, unknown> | null | undefined;
  if (k && typeof k === "object" && s(k.table) && s(k.source) && s(k.target)) links = { table: k.table, source: k.source, target: k.target, ...opt(k, "type") };
  let via: DbMapping["via"];
  const v = m.via as Record<string, unknown> | null | undefined;
  if (m.layout === "two-tables" && v && typeof v === "object" && s(v.table) && s(v.id) && s(v.book) && (v.kind === "part" || v.kind === "edition"))
    via = { table: v.table, id: v.id, book: v.book, ...opt(v, "order"), ...opt(v, "title"), kind: v.kind };
  return { layout: m.layout, ...(books && { books }), lines, ...(links && { links }), ...(via && { via }) };
}

export function parseSavedDbMappings(x: unknown): SavedDbMapping[] {
  if (!Array.isArray(x)) return [];
  const out: SavedDbMapping[] = [];
  for (const e of x.slice(0, 200)) {
    const o = e as Record<string, unknown> | null;
    const mapping = o && typeof o === "object" ? parseDbMapping(o.mapping) : null;
    if (mapping && s(o!.fingerprint) && typeof o!.label === "string") out.push({ fingerprint: o!.fingerprint, label: o!.label.slice(0, 256), mapping });
  }
  return out;
}

/** One sentence describing a mapping, for the wizard's summary and notices. */
export function describeMapping(m: DbMapping): string {
  const order = [m.lines.order === ROWID ? "סדר הרשומות" : m.lines.order, ...(m.lines.orderThen ?? [])].join(" ואז ");
  const unit = m.lines.unit && m.lines.unit !== "line" ? `, ${UNIT_LABEL[m.lines.unit]}` : "";
  const tail = `${m.lines.heading ? `, כותרת: ${m.lines.heading}` : ""}${unit}`;
  const links = m.links ? `; קישורים מ"${m.links.table}"` : "";
  if (m.layout === "two-tables") {
    const via = m.via ? `; ${m.via.kind === "edition" ? "מהדורות" : "פרקים"} מ"${m.via.table}"` : "";
    return `ספרים מ"${m.books!.table}" (שם: ${m.books!.title})${via}; שורות מ"${m.lines.table}" (${m.via ? (m.via.kind === "edition" ? "מהדורה" : "פרק") : "ספר"}: ${m.lines.book}, סדר: ${order}, טקסט: ${m.lines.text}${tail})${links}`;
  }
  return `טבלה אחת, "${m.lines.table}": שם הספר ב־${m.lines.book}, סדר: ${order}, טקסט: ${m.lines.text}${tail}${links}`;
}

export const UNIT_LABEL: Record<TextUnit, string> = {
  line: "כל רשומה היא שורה",
  lines: "כמה שורות בכל רשומה",
  chunks: "הטקסט מחולק לקטעים",
  json: "JSON של שורות ופרקים",
};
