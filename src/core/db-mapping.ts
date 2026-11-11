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
  columns: ColumnPreview[];
  indexes: IndexPreview[];
  /** the first rows, as short display strings aligned to `columns` */
  samples: string[][];
  /** leaf pages of the table's b-tree: a cheap measure of its size */
  pages: number;
}

export interface SchemaPreview {
  /** identifies the schema (hash of sqlite_master): the same schema reuses a saved mapping */
  fingerprint: string;
  tables: TablePreview[];
  /** what else was seen (views, virtual tables, compressed or binary columns…), in Hebrew */
  notes: string[];
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
  };
  /** optional: an existing links table whose two columns hold line ids (the lines table's rowid) */
  links?: { table: string; source: string; target: string; type?: string };
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
  if (lines) {
    column(lines, m.lines.book, m.layout === "two-tables" ? "הספר של כל שורה" : "שם הספר");
    const order = column(lines, m.lines.order, "סדר השורות", { rowid: true });
    const text = column(lines, m.lines.text, "טקסט השורה");
    column(lines, m.lines.heading, "רמת כותרת", { optional: true });
    if (m.layout === "single-table") column(lines, m.lines.path, "נתיב", { optional: true });
    if (text && text !== "rowid") {
      if (text.kind === "binary") err(`העמודה "${text.name}" מכילה נתונים בינאריים שאינם טקסט, ואי אפשר להציג אותם.`);
      else if (text.kind === "integer" || text.kind === "real") out.push({ level: "warning", message: `העמודה "${text.name}" מכילה מספרים. האם זו באמת עמודת הטקסט?` });
      else if (text.kind === "empty") out.push({ level: "warning", message: `בשורות הראשונות העמודה "${text.name}" ריקה.` });
    }
    if (lines.withoutRowid && order) {
      const pk = lines.primaryKey.map((x) => x.toLowerCase());
      if (pk[0] !== m.lines.book.toLowerCase() || pk[1] !== m.lines.order.toLowerCase())
        err(`הטבלה "${lines.name}" היא WITHOUT ROWID, והכלי קורא אותה רק כשהמפתח הראשי שלה מתחיל ב(${m.lines.book}, ${m.lines.order}).`);
    }
    if (!out.some((p) => p.level === "error") && !lines.withoutRowid && !hasSeekableIndex(lines, m.lines.book))
      out.push({
        level: "info",
        message: `אין בטבלה "${lines.name}" אינדקס לפי ${m.layout === "two-tables" ? "ספר" : "שם הספר"}, ולכן בפתיחה הכלי יקרא אותה פעם אחת מתחילתה ועד סופה ויבנה אינדקס בזיכרון. במסד גדול זה ייקח זמן (אפשר לבטל).`,
      });
  }
  if (m.links) {
    const lt = table(m.links.table, "הקישורים");
    if (lt) {
      column(lt, m.links.source, "שורת המקור");
      column(lt, m.links.target, "שורת היעד");
      column(lt, m.links.type, "סוג הקישור", { optional: true });
    }
    if (lines?.withoutRowid) err("קישורים נקראים לפי מזהה השורה (rowid), ולטבלת השורות אין rowid.");
  }
  return out;
}

export const hasSeekableIndex = (t: TablePreview, firstColumn: string): boolean =>
  t.indexes.some((ix) => ix.seekable && ix.columns[0]?.toLowerCase() === firstColumn.toLowerCase());

/* ---------------- the automatic guess ---------------- */

const RX = {
  title: /^(title|name|book_?title|book_?name|sefer|heb_?title|he_?title|שם|כותרת|שם_?ספר)$/i,
  titleLoose: /title|name|שם|כותרת/i,
  id: /^(id|book_?id|_id|bid|key)$/i,
  bookRef: /^(book_?id|bookid|book|sefer_?id|work_?id|id_?book|ספר|book_?key)$/i,
  bookRefLoose: /book|sefer|work|ספר/i,
  order: /^(line_?index|line_?idx|line_?no|line_?num(ber)?|index|idx|ord|order|order_?index|seq|sequence|position|pos|num|number|line|row_?num|סדר|מספר)$/i,
  orderLoose: /index|order|seq|pos|num|סדר/i,
  text: /^(content|text|line|body|html|line_?text|txt|value|תוכן|טקסט)$/i,
  textLoose: /content|text|body|html|תוכן|טקסט/i,
  heading: /^(heading|heading_?level|level|header_?level|h_?level|toc_?level|depth)$/i,
  path: /^(path|file|file_?path|folder|dir)$/i,
  category: /^(category|category_?id|cat|categoryid|genre|section|קטגוריה)$/i,
  linkSource: /^(source|src|from|line_?id_?1|source_?line(_?id)?|from_?line(_?id)?|line1|line_?from|src_?line)$/i,
  linkTarget: /^(target|dst|to|line_?id_?2|target_?line(_?id)?|to_?line(_?id)?|line2|line_?to|dst_?line)$/i,
  linkType: /^(type|kind|connection_?type(_?id)?|link_?type|relation)$/i,
};

const textual = (c: ColumnPreview) => TEXTUAL.has(c.kind);
const integral = (c: ColumnPreview) => c.kind === "integer" || c.rowidAlias;

function bestTextColumn(t: TablePreview): ColumnPreview | null {
  let best: ColumnPreview | null = null;
  let score = 0;
  for (const c of t.columns) {
    if (!textual(c)) continue;
    const s = c.avgLength * (RX.text.test(c.name) ? 3 : RX.textLoose.test(c.name) ? 2 : 1) + (c.kind === "html" ? 5 : 0);
    if (s > score) (best = c), (score = s);
  }
  return best;
}

function titleColumn(t: TablePreview, exclude?: string): ColumnPreview | null {
  const cands = t.columns.filter((c) => textual(c) && c.name !== exclude && c.avgLength > 0 && c.avgLength <= 200);
  return cands.find((c) => RX.title.test(c.name)) ?? cands.find((c) => RX.titleLoose.test(c.name)) ?? null;
}

function idColumn(t: TablePreview): string | null {
  if (t.withoutRowid) return t.primaryKey[0] ?? null;
  const alias = t.columns.find((c) => c.rowidAlias);
  if (alias) return alias.name;
  return t.columns.find((c) => RX.id.test(c.name))?.name ?? ROWID;
}

function orderColumn(t: TablePreview, exclude: string[]): string {
  const cands = t.columns.filter((c) => !exclude.includes(c.name) && (integral(c) || c.kind === "real") && !c.rowidAlias);
  const hit = cands.find((c) => RX.order.test(c.name)) ?? cands.find((c) => RX.orderLoose.test(c.name));
  if (hit) return hit.name;
  if (t.withoutRowid) return t.primaryKey[1] ?? t.primaryKey[0] ?? "";
  return ROWID;
}

function headingColumn(t: TablePreview, exclude: string[]): string | undefined {
  return t.columns.find((c) => !exclude.includes(c.name) && integral(c) && RX.heading.test(c.name))?.name;
}

function linksGuess(preview: SchemaPreview, skip: string[]): DbMapping["links"] {
  for (const t of preview.tables) {
    if (skip.includes(t.name) || !/link|connection|relation|קישור/i.test(t.name)) continue;
    const ints = t.columns.filter(integral);
    const source = ints.find((c) => RX.linkSource.test(c.name));
    const target = ints.find((c) => RX.linkTarget.test(c.name));
    if (!source || !target) continue;
    const type = t.columns.find((c) => c !== source && c !== target && RX.linkType.test(c.name));
    return { table: t.name, source: source.name, target: target.name, ...(type && { type: type.name }) };
  }
  return undefined;
}

/**
 * A plausible mapping from names and sample values, or null. It is only a starting point: the
 * wizard always shows it to the user, who confirms or corrects it.
 */
export function guessMapping(preview: SchemaPreview): DbMapping | null {
  // the lines table: the one with the most text (by size, then by average text length)
  const withText = preview.tables
    .map((t) => ({ t, text: bestTextColumn(t) }))
    .filter((x): x is { t: TablePreview; text: ColumnPreview } => x.text !== null)
    .sort((a, b) => b.t.pages - a.t.pages || b.text.avgLength - a.text.avgLength);
  for (const { t: lines, text } of withText) {
    // two tables: a column of the lines table refers to another table that has titles
    const refs = lines.columns.filter((c) => c !== text && (integral(c) || textual(c)) && !c.rowidAlias);
    const ref = refs.find((c) => RX.bookRef.test(c.name)) ?? refs.find((c) => RX.bookRefLoose.test(c.name) && integral(c));
    if (ref) {
      const books = preview.tables
        .filter((b) => b !== lines && titleColumn(b))
        .sort((a, b) => Number(/book|sefer|ספר/i.test(b.name)) - Number(/book|sefer|ספר/i.test(a.name)) || a.pages - b.pages)[0];
      if (books) {
        const title = titleColumn(books)!;
        const id = idColumn(books);
        const path = books.columns.find((c) => RX.path.test(c.name) && textual(c));
        const category = books.columns.find((c) => RX.category.test(c.name));
        const order = orderColumn(lines, [ref.name, text.name]);
        const heading = headingColumn(lines, [ref.name, text.name, order]);
        const links = linksGuess(preview, [lines.name, books.name]);
        if (id && order)
          return {
            layout: "two-tables",
            books: { table: books.name, id, title: title.name, ...(path && { path: path.name }), ...(category && { category: category.name }) },
            lines: { table: lines.name, book: ref.name, order, text: text.name, ...(heading && { heading }) },
            ...(links && { links }),
          };
      }
    }
    // one table: a short text column whose values repeat (the book title of every line)
    const title = titleColumn(lines, text.name) ?? lines.columns.find((c) => c !== text && textual(c) && c.avgLength <= 120 && c.distinct < c.filled);
    if (title) {
      const order = orderColumn(lines, [title.name, text.name]);
      const heading = headingColumn(lines, [title.name, text.name, order]);
      const path = lines.columns.find((c) => RX.path.test(c.name) && textual(c) && c !== title);
      const links = linksGuess(preview, [lines.name]);
      if (order)
        return {
          layout: "single-table",
          lines: { table: lines.name, book: title.name, order, text: text.name, ...(heading && { heading }), ...(path && { path: path.name }) },
          ...(links && { links }),
        };
    }
  }
  return null;
}

/* ---------------- reading a mapping back from untrusted JSON ---------------- */

const s = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 256;
const opt = (o: Record<string, unknown>, k: string) => (s(o[k]) ? { [k]: o[k] as string } : {});

/** Rebuilds a mapping field by field from untrusted data (a project file); null when it is not one. */
export function parseDbMapping(x: unknown): DbMapping | null {
  const m = x as Record<string, unknown> | null;
  if (!m || typeof m !== "object" || (m.layout !== "two-tables" && m.layout !== "single-table")) return null;
  const l = m.lines as Record<string, unknown> | null;
  if (!l || typeof l !== "object" || !s(l.table) || !s(l.book) || !s(l.order) || !s(l.text)) return null;
  const lines = { table: l.table, book: l.book, order: l.order, text: l.text, ...opt(l, "heading"), ...(m.layout === "single-table" ? opt(l, "path") : {}) };
  let books: DbMapping["books"];
  if (m.layout === "two-tables") {
    const b = m.books as Record<string, unknown> | null;
    if (!b || typeof b !== "object" || !s(b.table) || !s(b.id) || !s(b.title)) return null;
    books = { table: b.table, id: b.id, title: b.title, ...opt(b, "path"), ...opt(b, "category") };
  }
  let links: DbMapping["links"];
  const k = m.links as Record<string, unknown> | null | undefined;
  if (k && typeof k === "object" && s(k.table) && s(k.source) && s(k.target)) links = { table: k.table, source: k.source, target: k.target, ...opt(k, "type") };
  return { layout: m.layout, ...(books && { books }), lines, ...(links && { links }) };
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
  const order = (o: string) => (o === ROWID ? "סדר הרשומות" : o);
  if (m.layout === "two-tables")
    return `ספרים מ"${m.books!.table}" (שם: ${m.books!.title}); שורות מ"${m.lines.table}" (ספר: ${m.lines.book}, סדר: ${order(m.lines.order)}, טקסט: ${m.lines.text}${m.lines.heading ? `, כותרת: ${m.lines.heading}` : ""})${m.links ? `; קישורים מ"${m.links.table}"` : ""}`;
  return `טבלה אחת, "${m.lines.table}": שם הספר ב־${m.lines.book}, סדר: ${order(m.lines.order)}, טקסט: ${m.lines.text}${m.lines.heading ? `, כותרת: ${m.lines.heading}` : ""}${m.links ? `; קישורים מ"${m.links.table}"` : ""}`;
}
