import { ROWID, unsortedKeyMessage, virtualColumnMessage, withoutRowidViaMessage, type DbMapping, type TextUnit } from "../../core/db-mapping";
import { jsonLines, splitLines } from "../../core/db-text-units";
import { LinkerError } from "../../core/errors";
import { headingLevel } from "../../core/text/html";
import { compareValues, type SqlValue } from "../sqlite/lazy/record";
import type { IndexInfo, Row, SqliteFile, TableInfo } from "../sqlite/lazy/sqlite-file";
import { GenericTextCodec } from "./text-codec";

/*
 * Reads books and lines of an arbitrary SQLite database through a user-confirmed DbMapping, lazily,
 * through the page reader. Lines are never loaded per table — only per requested chunk — and a book's
 * line ORDER is kept as a compact locator (rowids in order, a Float64Array):
 *
 *   • "index": the lines table has a seekable index whose first column is the book column. A book's
 *     locator is read from that index when the book is first opened (cached, LRU), and nothing is
 *     scanned at open time — opening is as fast as listing the books.
 *   • "scan":  there is no such index (or the single-table layout, where the book list itself must be
 *     discovered, or a links table that needs every line id, or a chapters/versions table between
 *     lines and books). ONE sequential pass over the lines table — or over a narrower index that has
 *     the book column first — builds the locators of every book, with progress and cancel. Memory:
 *     one number per line (8 bytes).
 *
 * WITHOUT ROWID lines tables are read when their primary key starts with (book, order, …orderThen):
 * the locator is then the list of key tuples, and chunks are fetched with one ordered multi-seek.
 *
 * A row is one line by default. With another text unit (a whole book or chapter per row, chunks of
 * one text, JSON) the locator lists the book's ROWS, and the book's lines are made from them when the
 * book is first read (cached, LRU) — its line count is known only then.
 */
export interface MappedBook {
  /** position in `books` — the id inside the source */
  n: number;
  title: string;
  path: string | null;
  /** known after a scan; null with the "index" strategy until the book is read, and with a text unit other than "line" */
  lineCount: number | null;
}

export interface MappedLine {
  index: number;
  text: string;
  heading: number | null;
}

export interface MappedLinkEnd {
  book: number;
  line: number;
}

export interface MappedLink {
  id: number;
  source: MappedLinkEnd;
  target: MappedLinkEnd;
  /** raw value of the type column (null when unmapped or empty) */
  type: SqlValue;
}

export interface ReadContext {
  signal?: AbortSignal;
  progress?: (done: number, total: number) => void;
  /** read at most this many rows of each table (the wizard's "test the mapping"); sets `partial` */
  limitRows?: number;
}

type Locator = { kind: "rowid"; ids: Float64Array } | { kind: "pk"; keys: SqlValue[][] };
/** a line's (or row's) place inside its book: one value, or a tuple for a composite order */
type OrderKey = SqlValue | SqlValue[];

const MAX_BOOKS = 1_000_000;
const MAX_LINKS = 5_000_000;
const CACHE_LINES = 4_000_000;
/** characters of one book made from multi-line rows: beyond this the book is refused, not read */
const MAX_BOOK_CHARS = 64 * 1024 ** 2;
/** characters of expanded books kept in memory */
const CACHE_CHARS = 32 * 1024 ** 2;

/** A value as a grouping key: 5, 5.0 and "5" are the same book (column affinity differs between tables). */
function keyOf(v: SqlValue): string {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "bigint") return `n${v}`;
  if (typeof v === "string") return /^-?\d+(\.0+)?$/.test(v.trim()) ? `n${Number(v)}` : `s${v}`;
  return `b${Array.from(v).join(",")}`;
}

/** The other storage form of a key value (5 ↔ "5"), for a seek that found nothing. */
function altForm(v: SqlValue): SqlValue | undefined {
  if (typeof v === "number") return String(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v);
  return undefined;
}

export class MappedDbReader {
  readonly books: MappedBook[] = [];
  readonly warnings: { code: string; message: string }[] = [];
  /** lines whose text could not be decoded (shown empty) */
  undecodable = 0;
  /** a table was read only up to ReadContext.limitRows */
  partial = false;
  private readonly bookValue: SqlValue[] = [];
  private readonly locators = new Map<number, Locator>();
  private cachedLines = 0;
  private links: LinkIndex | null = null;
  private readonly codec = new GenericTextCodec();
  private readonly col: { book: number; order: number; text: number; heading: number; path: number; then: number[] };
  private readonly unit: TextUnit;
  private readonly expanded = new Map<number, MappedLine[]>();
  private expandedChars = 0;
  private badJson = 0;

  private constructor(
    private readonly file: SqliteFile,
    private readonly m: DbMapping,
    private readonly t: TableInfo,
    readonly strategy: "index" | "scan",
    private readonly ix: IndexInfo | null,
  ) {
    const at = (name: string | undefined) => (name === undefined ? -2 : name === ROWID ? -1 : colIndex(t, name));
    this.col = {
      book: at(m.lines.book),
      order: at(m.lines.order),
      text: at(m.lines.text),
      heading: at(m.lines.heading),
      path: m.layout === "single-table" ? at(m.lines.path) : -2,
      then: (m.lines.orderThen ?? []).map(at),
    };
    for (const [k, v] of Object.entries(this.col)) if (v === -3) throw missing(t.name, String(m.lines[k as keyof DbMapping["lines"]]));
    (m.lines.orderThen ?? []).forEach((name, i) => {
      if (this.col.then[i]! < 0) throw this.col.then[i] === -1 ? new LinkerError("db/mapping-invalid", "סדר משני צריך להיות עמודה, לא סדר הרשומות.") : missing(t.name, name);
    });
    this.unit = m.lines.unit ?? "line";
  }

  static async open(file: SqliteFile, m: DbMapping, ctx: ReadContext = {}): Promise<MappedDbReader> {
    const t = await file.table(m.lines.table);
    if (!t) throw new LinkerError("db/mapping-invalid", `הטבלה "${m.lines.table}" אינה קיימת במסד. בדקו את המיפוי.`);
    const then = m.lines.orderThen ?? [];
    if (then.length && m.lines.order === ROWID) throw new LinkerError("db/mapping-invalid", "סדר משני בא אחרי עמודת סדר. בחרו עמודה לסדר השורות.");
    if (m.links && (m.lines.unit ?? "line") !== "line")
      throw new LinkerError("db/mapping-invalid", "קישורים נקראים לפי מזהה השורה (rowid), ובמיפוי הזה רשומה אינה שורה אחת. הסירו את טבלת הקישורים מהמיפוי.");
    if (m.via && m.layout !== "two-tables") throw new LinkerError("db/mapping-invalid", "טבלת פרקים או מהדורות אפשרית רק עם טבלת ספרים וטבלת שורות.");
    if (t.withoutRowid) {
      const pk = t.primaryKey.map((x) => x.toLowerCase());
      const want = [m.lines.book, m.lines.order, ...then];
      if (want.some((x, i) => pk[i] !== x.toLowerCase()))
        throw new LinkerError("db/mapping-invalid", `הטבלה "${t.name}" היא WITHOUT ROWID, והכלי קורא אותה רק כשהמפתח הראשי שלה מתחיל ב(${want.join(", ")}).`);
      if (!t.primaryKeySeekable) throw new LinkerError("db/mapping-invalid", unsortedKeyMessage(t.name));
      if (m.links) throw new LinkerError("db/mapping-invalid", "קישורים נקראים לפי מזהה השורה (rowid), ולטבלת השורות אין rowid.");
      if (m.via) throw new LinkerError("db/mapping-invalid", withoutRowidViaMessage(t.name));
    }
    await refuseVirtualColumns(file, m);
    const ix = t.withoutRowid ? null : await bookIndex(file, t, m.lines.book, m.lines.order);
    const lazy = m.layout === "two-tables" && !m.links && !m.via && (t.withoutRowid || ix !== null);
    const r = new MappedDbReader(file, m, t, lazy ? "index" : "scan", ix);
    if (m.layout === "two-tables") await r.readBooks(ctx);
    if (!lazy) await r.scanLines(ctx);
    if (m.links) r.links = await r.readLinks(ctx);
    if (!r.books.length) r.warnings.push({ code: "db/mapping-no-books", message: "לפי המיפוי הזה אין במסד אף ספר. בדקו שבחרתם את הטבלאות והעמודות הנכונות." });
    return r;
  }

  /* ---------------- books ---------------- */

  private async readBooks(ctx: ReadContext): Promise<void> {
    const b = this.m.books!;
    const bt = await this.file.table(b.table);
    if (!bt) throw new LinkerError("db/mapping-invalid", `הטבלה "${b.table}" אינה קיימת במסד. בדקו את המיפוי.`);
    const [id, title, path, category] = [b.id, b.title, b.path, b.category].map((c) => (c === undefined ? -2 : c === ROWID ? -1 : colIndex(bt, c)));
    for (const [name, at] of [[b.id, id], [b.title, title], [b.path, path], [b.category, category]] as const) if (at === -3) throw missing(bt.name, name!);
    const seen = new Set<string>();
    let dup = 0;
    await this.each(this.file.scan(bt), await this.file.leafCount(bt.rootPage), ctx, (row) => {
      const idVal = id === -1 ? row.rowid : row.values[id!]!;
      const k = keyOf(idVal ?? null);
      if (seen.has(k)) return void dup++;
      seen.add(k);
      if (this.books.length >= MAX_BOOKS) throw new LinkerError("db/mapping-invalid", `בטבלת הספרים יותר מ־${MAX_BOOKS.toLocaleString("he")} רשומות — כנראה נבחרה טבלה לא נכונה.`);
      const n = this.books.length;
      const p = path! >= 0 ? this.str(row.values[path!]) : null;
      const c = category! >= 0 ? this.str(row.values[category!]) : null;
      this.books.push({ n, title: this.titleOf(row.values[title!], n), path: p || (c ? `${c}` : null), lineCount: null });
      this.bookValue.push(idVal ?? null);
    });
    if (dup) this.warnings.push({ code: "db/mapping-duplicate-books", message: `${dup} רשומות בטבלת הספרים חוזרות על מזהה שכבר הופיע, ודולגו.` });
  }

  /**
   * The chapters/versions table between lines and books (DbMapping.via): a map from its id to the
   * book (by position) and the row's order. With "edition" every row becomes a book of its own.
   */
  private async readVia(ctx: ReadContext): Promise<Map<string, { n: number; order: SqlValue }>> {
    const v = this.m.via!;
    const vt = await this.file.table(v.table);
    if (!vt) throw new LinkerError("db/mapping-invalid", `הטבלה "${v.table}" אינה קיימת במסד. בדקו את המיפוי.`);
    const [id, book, order, title] = [v.id, v.book, v.order, v.title].map((c) => (c === undefined ? -2 : c === ROWID ? -1 : colIndex(vt, c)));
    for (const [name, at] of [[v.id, id], [v.book, book], [v.order, order], [v.title, title]] as const) if (at === -3) throw missing(vt.name, name!);
    const byBook = new Map<string, number>();
    this.bookValue.forEach((val, n) => byBook.set(keyOf(val), n));
    const rows: { id: SqlValue; n: number; order: SqlValue; title: string | null; at: number }[] = [];
    let orphans = 0;
    await this.each(this.file.scan(vt), await this.file.leafCount(vt.rootPage), ctx, (row, i) => {
      const val = (at: number) => (at === -1 ? row.rowid : at >= 0 ? (row.values[at] ?? null) : null);
      const n = byBook.get(keyOf(val(book!)));
      if (n === undefined) return void orphans++;
      rows.push({ id: val(id!), n, order: order === -2 ? row.rowid : val(order!), title: title! >= 0 ? this.str(row.values[title!]) : null, at: i });
    });
    if (orphans) this.warnings.push({ code: "db/mapping-orphan-parts", message: `${orphans.toLocaleString("he")} רשומות בטבלה "${vt.name}" אינן שייכות לאף ספר, והשורות שלהן לא יוצגו.` });
    const out = new Map<string, { n: number; order: SqlValue }>();
    if (v.kind === "part") {
      for (const r of rows) out.set(keyOf(r.id), { n: r.n, order: r.order });
      return out;
    }
    // editions: a book per row, in the order of the books and then of the rows
    const base = this.books.splice(0);
    this.bookValue.splice(0);
    rows.sort((a, b) => a.n - b.n || compareValues(a.order, b.order) || a.at - b.at);
    const count = new Map<number, number>();
    for (const r of rows) {
      const k = (count.get(r.n) ?? 0) + 1;
      count.set(r.n, k);
      const n = this.books.length;
      this.books.push({ n, title: `${base[r.n]!.title} — ${r.title?.trim() || `מהדורה ${k}`}`, path: base[r.n]!.path, lineCount: null });
      this.bookValue.push(r.id);
      out.set(keyOf(r.id), { n, order: null });
    }
    return out;
  }

  /* ---------------- lines ---------------- */

  /**
   * One pass that builds the locator of every book. Reads the narrow index (book first) when it has
   * the order too and nothing else is needed from the rows; otherwise the table itself.
   */
  private async scanLines(ctx: ReadContext): Promise<void> {
    const single = this.m.layout === "single-table";
    const via = this.m.via ? await this.readVia(ctx) : null;
    const part = this.m.via?.kind === "part";
    const byKey = new Map<string, number>();
    if (!single && !via) this.bookValue.forEach((v, n) => byKey.set(keyOf(v), n));
    const ids: number[][] = [];
    const orders: OrderKey[][] = [];
    const orderIsRowid = this.col.order === -1 && !part;
    let orphans = 0;
    let sorted = true;

    const add = (bookVal: SqlValue, order: OrderKey, rowid: number, row: Row | null) => {
      const k = keyOf(bookVal);
      let n: number | undefined;
      if (via) {
        const hit = via.get(k);
        if (!hit) return void orphans++;
        n = hit.n;
        if (part) order = [hit.order, ...(Array.isArray(order) ? order : [order ?? rowid])];
      } else n = byKey.get(k);
      if (n === undefined) {
        if (!single || bookVal === null) return void orphans++;
        if (this.books.length >= MAX_BOOKS) throw new LinkerError("db/mapping-invalid", `לפי המיפוי יש במסד יותר מ־${MAX_BOOKS.toLocaleString("he")} ספרים — כנראה נבחרה עמודת שם לא נכונה.`);
        n = this.books.length;
        byKey.set(k, n);
        const path = row && this.col.path >= 0 ? this.str(row.values[this.col.path]) : null;
        this.books.push({ n, title: this.titleOf(bookVal, n), path: path || null, lineCount: 0 });
        this.bookValue.push(bookVal);
      }
      (ids[n] ??= []).push(rowid);
      if (!orderIsRowid) (orders[n] ??= []).push(order);
    };

    const then = this.m.lines.orderThen ?? [];
    const ixKey = [this.m.lines.order, ...then].map((c) => c.toLowerCase());
    const ixHasOrder = this.ix !== null && ixKey.every((c, i) => this.ix!.columns[i + 1]?.toLowerCase() === c);
    const fromIndex = this.ix !== null && this.col.path < 0 && !part && (orderIsRowid ? this.ix.columns.length === 1 : ixHasOrder);
    if (this.t.withoutRowid) {
      // primary-key order is (book, order, …): every book's rows come together and already sorted
      await this.each(this.file.scan(this.t), await this.file.leafCount(this.t.rootPage), ctx, (row, i) =>
        add(row.values[this.col.book]!, [this.col.order, ...this.col.then].map((c) => row.values[c]!), i, row),
      );
    } else if (fromIndex) {
      // entries [book, (order, …then,) rowid] in key order — already sorted inside each book
      await this.each(this.file.seekIndex(this.ix!, []), await this.file.leafCount(this.ix!.rootPage), ctx, (rec) =>
        add(rec[0]!, orderIsRowid ? null : then.length ? rec.slice(1, 2 + then.length) : rec[1]!, Number(rec[rec.length - 1]), null),
      );
    } else {
      await this.each(this.file.scan(this.t), await this.file.leafCount(this.t.rootPage), ctx, (row) => add(row.values[this.col.book]!, orderIsRowid ? null : this.orderOf(row), row.rowid!, row));
      sorted = orderIsRowid; // a table scan is in rowid order
    }
    for (const b of this.books) {
      const list = ids[b.n] ?? [];
      if (this.t.withoutRowid) this.store(b.n, { kind: "pk", keys: (orders[b.n] ?? []) as SqlValue[][] });
      else this.store(b.n, { kind: "rowid", ids: sorted ? Float64Array.from(list) : sortByOrder(list, orders[b.n] ?? []) });
      b.lineCount = this.unit === "line" ? list.length : null;
    }
    if (orphans)
      this.warnings.push({
        code: "db/mapping-orphan-lines",
        message: `${orphans.toLocaleString("he")} שורות לא שייכות לאף ${via ? (part ? "פרק" : "מהדורה") : "ספר"} ${via ? `בטבלה "${this.m.via!.table}"` : "בטבלת הספרים"} (או שהעמודה שלהן ריקה), ולכן לא יוצגו.`,
      });
  }

  private orderOf(row: Row): OrderKey {
    const first = this.col.order === -1 ? row.rowid : row.values[this.col.order]!;
    return this.col.then.length ? [first, ...this.col.then.map((c) => row.values[c]!)] : first;
  }

  /** Rows [from, to] (0-based positions in the locator, inclusive) of a book, in order (missing rows undefined). */
  private async rowsOf(n: number, a: number, b: number): Promise<(Row | undefined)[]> {
    const loc = await this.locatorOf(n);
    const rows: (Row | undefined)[] = [];
    if (loc.kind === "rowid") {
      const want = Array.from(loc.ids.subarray(a, b + 1));
      const got = await this.file.getMany(this.t, want);
      for (const id of want) rows.push(got.get(id));
      return rows;
    }
    const bookVal = this.bookValue[n]!;
    const got = await this.file.seekPrimaryKeyMany(this.t, loc.keys.slice(a, b + 1).map((k) => [bookVal, ...k]));
    const enc = this.file.header.encoding;
    const keyOfRow = (r: Row) => [this.col.order, ...this.col.then].map((c) => r.values[c]!);
    const cmp = (x: SqlValue[], y: SqlValue[]) => {
      for (let i = 0; i < x.length; i++) {
        const c = compareValues(x[i]!, y[i]!, enc);
        if (c) return c;
      }
      return 0;
    };
    let k = 0;
    for (let i = a; i <= b; i++) {
      const want = loc.keys[i]!;
      while (k < got.length && cmp(keyOfRow(got[k]!), want) < 0) k++;
      rows.push(k < got.length && cmp(keyOfRow(got[k]!), want) === 0 ? got[k++] : undefined);
    }
    return rows;
  }

  /** Lines [from, to] (0-based positions, inclusive) of a book. */
  async lines(n: number, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<MappedLine[]> {
    if (this.unit !== "line") {
      const all = await this.expand(n);
      return all.slice(Math.max(0, from), Math.min(all.length - 1, to) + 1);
    }
    const count = await this.lineCount(n);
    const a = Math.max(0, from);
    const b = Math.min(count - 1, to);
    if (b < a) return [];
    return (await this.rowsOf(n, a, b)).map((row, i) => {
      const text = this.textOf(row);
      return { index: a + i, text, heading: this.headingOf(row, text) };
    });
  }

  async lineCount(n: number): Promise<number> {
    if (this.unit !== "line") return (await this.expand(n)).length;
    const loc = await this.locatorOf(n);
    return loc.kind === "rowid" ? loc.ids.length : loc.keys.length;
  }

  private textOf(row: Row | undefined): string {
    try {
      return row ? (this.codec.decode(row.values[this.col.text]) ?? "") : "";
    } catch {
      this.undecodable++;
      return "";
    }
  }

  /** A book whose rows hold several lines each (unit "lines", "chunks" or "json"): all its lines, cached. */
  private async expand(n: number): Promise<MappedLine[]> {
    const hit = this.expanded.get(n);
    if (hit) {
      this.expanded.delete(n);
      this.expanded.set(n, hit); // LRU
      return hit;
    }
    const loc = await this.locatorOf(n);
    const rowCount = loc.kind === "rowid" ? loc.ids.length : loc.keys.length;
    const out: MappedLine[] = [];
    let chars = 0;
    const push = (text: string, heading: number | null) => {
      chars += text.length;
      if (chars > MAX_BOOK_CHARS) throw new LinkerError("db/book-too-large", `הספר "${this.books[n]?.title}" גדול מ־64 מיליון תווים, ולכן אינו נקרא.`);
      out.push({ index: out.length, text, heading: heading ?? headingLevel(text) });
    };
    const STEP = 512;
    let pending = ""; // "chunks": the text after the last line break, until the next row
    for (let a = 0; a < rowCount; a += STEP) {
      for (const row of await this.rowsOf(n, a, Math.min(rowCount, a + STEP) - 1)) {
        const text = this.textOf(row);
        if (this.unit === "chunks") {
          const parts = (pending + text).split(/\r\n|\n|\r/);
          pending = parts.pop()!;
          for (const p of parts) push(p, null);
        } else if (this.unit === "json") {
          const lines = jsonLines(text);
          if (lines) for (const l of lines) push(l.text, l.heading);
          else if (text) {
            this.badJson++;
            for (const l of splitLines(text)) push(l, null);
          }
        } else for (const l of splitLines(text)) push(l, null);
      }
    }
    if (pending) push(pending, null);
    if (this.badJson && !this.warnings.some((w) => w.code === "db/mapping-bad-json"))
      this.warnings.push({ code: "db/mapping-bad-json", message: "חלק מהערכים בעמודת הטקסט אינם JSON תקין; הם הוצגו כטקסט כמו שהוא." });
    this.books[n]!.lineCount = out.length;
    this.expanded.set(n, out);
    this.expandedChars += chars;
    while (this.expandedChars > CACHE_CHARS && this.expanded.size > 1) {
      const [oldest, lines] = this.expanded.entries().next().value as [number, MappedLine[]];
      this.expanded.delete(oldest);
      this.expandedChars -= lines.reduce((s, l) => s + l.text.length, 0);
    }
    return out;
  }

  private headingOf(row: Row | undefined, text: string): number | null {
    if (this.col.heading < 0) return headingLevel(text);
    const v = Number(row?.values[this.col.heading] ?? 0);
    return Number.isInteger(v) && v >= 1 && v <= 6 ? v : null;
  }

  private async locatorOf(n: number): Promise<Locator> {
    const hit = this.locators.get(n);
    if (hit) {
      if (this.strategy === "index") this.locators.delete(n), this.locators.set(n, hit); // LRU
      return hit;
    }
    if (this.strategy === "scan" || n < 0 || n >= this.books.length) throw new LinkerError("source/closed", "הספר הזה אינו קיים במקור.");
    const loc = await this.readLocator(this.bookValue[n]!);
    if (loc.kind === "rowid" ? !loc.ids.length : !loc.keys.length) {
      const alt = altForm(this.bookValue[n]!);
      if (alt !== undefined) {
        const other = await this.readLocator(alt);
        if (other.kind === "rowid" ? other.ids.length : other.keys.length) this.bookValue[n] = alt;
        this.store(n, other);
        return other;
      }
    }
    this.store(n, loc);
    return loc;
  }

  /** The "index" strategy: one book's line order, from the index (or the primary key). */
  private async readLocator(bookVal: SqlValue): Promise<Locator> {
    if (this.t.withoutRowid) {
      const keys: SqlValue[][] = [];
      for await (const r of this.file.seekPrimaryKey(this.t, [bookVal])) keys.push([this.col.order, ...this.col.then].map((c) => r.values[c]!));
      return { kind: "pk", keys };
    }
    const ix = this.ix!;
    const ids: number[] = [];
    const ord: OrderKey[] = [];
    const then = this.m.lines.orderThen ?? [];
    const want = [this.m.lines.order, ...then].map((c) => c.toLowerCase());
    const k = ix.columns.findIndex((c, i) => i > 0 && c.toLowerCase() === want[0]);
    const covered = k > 0 && want.every((c, j) => ix.columns[k + j]?.toLowerCase() === c);
    for await (const rec of this.file.seekIndex(ix, [bookVal])) {
      ids.push(Number(rec[rec.length - 1]));
      if (covered) ord.push(then.length ? rec.slice(k, k + want.length) : rec[k]!);
    }
    if (this.col.order === -1) return { kind: "rowid", ids: k === -1 && ix.columns.length === 1 ? Float64Array.from(ids) : Float64Array.from(ids).sort() };
    if (covered && k === 1) return { kind: "rowid", ids: Float64Array.from(ids) };
    if (covered) return { kind: "rowid", ids: sortByOrder(ids, ord) };
    // the order is not in the index: read the book's rows once to learn it
    const rows = await this.file.getMany(this.t, ids);
    return { kind: "rowid", ids: sortByOrder(ids, ids.map((id) => (rows.has(id) ? this.orderOf(rows.get(id)!) : null))) };
  }

  private store(n: number, loc: Locator): void {
    const size = loc.kind === "rowid" ? loc.ids.length : loc.keys.length;
    this.locators.set(n, loc);
    this.cachedLines += size;
    if (this.strategy !== "index") return;
    while (this.cachedLines > CACHE_LINES && this.locators.size > 1) {
      const [oldest, l] = this.locators.entries().next().value as [number, Locator];
      this.locators.delete(oldest);
      this.cachedLines -= l.kind === "rowid" ? l.ids.length : l.keys.length;
    }
  }

  /* ---------------- links ---------------- */

  private async readLinks(ctx: ReadContext): Promise<LinkIndex> {
    const lm = this.m.links!;
    const lt = await this.file.table(lm.table);
    if (!lt) throw new LinkerError("db/mapping-invalid", `הטבלה "${lm.table}" אינה קיימת במסד. בדקו את המיפוי.`);
    const [s, t, ty] = [lm.source, lm.target, lm.type].map((c) => (c === undefined ? -2 : c === ROWID ? -1 : colIndex(lt, c)));
    for (const [name, at] of [[lm.source, s], [lm.target, t], [lm.type, ty]] as const) if (at === -3) throw missing(lt.name, name!);
    const where = lineIdIndex(this.books.map((b) => this.locators.get(b.n)!));
    const out: MappedLink[] = [];
    let unresolved = 0;
    let capped = false;
    const val = (row: Row, at: number) => (at === -1 ? row.rowid : row.values[at]);
    await this.each(this.file.scan(lt), await this.file.leafCount(lt.rootPage), ctx, (row) => {
      if (out.length >= MAX_LINKS) return void (capped = true);
      const a = where(Number(val(row, s!)));
      const b = where(Number(val(row, t!)));
      if (!a || !b) return void unresolved++;
      out.push({ id: row.rowid ?? out.length, source: a, target: b, type: ty! >= 0 ? (row.values[ty!] ?? null) : null });
    });
    if (unresolved) this.warnings.push({ code: "db/mapping-links-unresolved", message: `${unresolved.toLocaleString("he")} קישורים בטבלה "${lt.name}" מפנים לשורות שאינן בספרים שנקראו, ולא יוצגו.` });
    if (capped) this.warnings.push({ code: "db/mapping-links-capped", message: `בטבלת הקישורים יותר מ־${MAX_LINKS.toLocaleString("he")} רשומות; נקראו הראשונות בלבד.` });
    return new LinkIndex(out);
  }

  /** Links whose source or target is in lines [from, to] of a book. */
  linksAt(n: number, from: number, to: number): MappedLink[] {
    return this.links ? this.links.at(n, from, to) : [];
  }

  get hasLinks(): boolean {
    return this.links !== null;
  }

  /* ---------------- helpers ---------------- */

  /**
   * Drives a full pass with progress (leaf pages read / leaf pages in the tree), cancel, a periodic
   * yield (so the worker sees a cancel message), and a cap on rows: a b-tree that yields more rows
   * than its pages can hold shares pages between parents — corrupt or hostile. With
   * ctx.limitRows the pass stops early and the reader is marked `partial`.
   */
  private async each<T>(it: AsyncIterable<T>, leaves: number, ctx: ReadContext, fn: (x: T, i: number) => void): Promise<void> {
    const start = this.file.pagesRead;
    const maxRows = Math.max(1, this.file.header.pageCount) * Math.floor(this.file.header.pageSize / 2);
    let i = 0;
    let lastYield = Date.now();
    for await (const x of it) {
      if (ctx.limitRows !== undefined && i >= ctx.limitRows) {
        this.partial = true;
        break;
      }
      fn(x, i);
      if (++i % 1024 === 0) {
        ctx.signal?.throwIfAborted();
        if (i > maxRows) throw new LinkerError("db/corrupt", "המסד פגום (עץ שמחזיר יותר רשומות ממה שהעמודים שלו יכולים להכיל). אי אפשר לקרוא אותו בבטחה.");
        ctx.progress?.(Math.min(this.file.pagesRead - start, leaves - 1), leaves);
        if (Date.now() - lastYield > 100) {
          await new Promise((r) => setTimeout(r, 0));
          lastYield = Date.now();
        }
      }
    }
    ctx.signal?.throwIfAborted();
  }

  private str(v: SqlValue | undefined): string | null {
    try {
      return this.codec.decode(v ?? null);
    } catch {
      return null;
    }
  }

  private titleOf(v: SqlValue | undefined, n: number): string {
    const s = this.str(v)?.trim();
    return s ? s : `ספר ללא שם ${n + 1}`;
  }
}

/** Order keys compared like SQLite compares values; a tuple element by element. */
function compareKeys(a: OrderKey | undefined, b: OrderKey | undefined): number {
  if (!Array.isArray(a) || !Array.isArray(b)) return compareValues((a ?? null) as SqlValue, (b ?? null) as SqlValue);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const c = compareValues(a[i] ?? null, b[i] ?? null);
    if (c) return c;
  }
  return 0;
}

/** Positions sorted by (order, rowid); returns the rowids in that order. */
function sortByOrder(ids: number[], orders: OrderKey[]): Float64Array {
  const perm = Array.from(ids.keys());
  const allNumbers = orders.every((o) => typeof o === "number");
  if (allNumbers) {
    const o = orders as number[];
    perm.sort((a, b) => o[a]! - o[b]! || ids[a]! - ids[b]!);
  } else perm.sort((a, b) => compareKeys(orders[a], orders[b]) || ids[a]! - ids[b]!);
  const out = new Float64Array(ids.length);
  perm.forEach((p, i) => (out[i] = ids[p]!));
  return out;
}

/** rowid → (book, position), by binary search over all line ids sorted once. */
function lineIdIndex(locs: Locator[]): (id: number) => MappedLinkEnd | null {
  let total = 0;
  for (const l of locs) if (l.kind === "rowid") total += l.ids.length;
  const ids = new Float64Array(total);
  const book = new Int32Array(total);
  const pos = new Int32Array(total);
  let k = 0;
  locs.forEach((l, n) => {
    if (l.kind !== "rowid") return;
    for (let i = 0; i < l.ids.length; i++) (ids[k] = l.ids[i]!), (book[k] = n), (pos[k] = i), k++;
  });
  const perm = Uint32Array.from(ids.keys()).sort((a, b) => ids[a]! - ids[b]!);
  const sorted = new Float64Array(total);
  perm.forEach((p, i) => (sorted[i] = ids[p]!));
  return (id) => {
    if (!Number.isFinite(id)) return null;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < id) lo = mid + 1;
      else hi = mid;
    }
    return lo < sorted.length && sorted[lo] === id ? { book: book[perm[lo]!]!, line: pos[perm[lo]!]! } : null;
  };
}

/** Links grouped by the book and line of each end, for range queries. */
class LinkIndex {
  private readonly bySide: Map<number, { pos: Int32Array; link: Int32Array }>;

  constructor(private readonly all: MappedLink[]) {
    const tmp = new Map<number, { pos: number; link: number }[]>();
    all.forEach((l, i) => {
      for (const e of l.source.book === l.target.book && l.source.line === l.target.line ? [l.source] : [l.source, l.target]) {
        const list = tmp.get(e.book) ?? [];
        list.push({ pos: e.line, link: i });
        tmp.set(e.book, list);
      }
    });
    this.bySide = new Map();
    for (const [b, list] of tmp) {
      list.sort((x, y) => x.pos - y.pos);
      this.bySide.set(b, { pos: Int32Array.from(list.map((x) => x.pos)), link: Int32Array.from(list.map((x) => x.link)) });
    }
  }

  at(book: number, from: number, to: number): MappedLink[] {
    const e = this.bySide.get(book);
    if (!e) return [];
    let lo = 0;
    let hi = e.pos.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (e.pos[mid]! < from) lo = mid + 1;
      else hi = mid;
    }
    const seen = new Set<number>();
    const out: MappedLink[] = [];
    for (let i = lo; i < e.pos.length && e.pos[i]! <= to; i++) {
      if (seen.has(e.link[i]!)) continue;
      seen.add(e.link[i]!);
      out.push(this.all[e.link[i]!]!);
    }
    return out;
  }
}

/**
 * The best seekable index that starts with the book column: (book, order) gives every book's lines
 * already in order; (book) alone does too when the order is the rowid; otherwise the narrowest one.
 */
async function bookIndex(file: SqliteFile, t: TableInfo, bookColumn: string, orderColumn: string): Promise<IndexInfo | null> {
  if (bookColumn === ROWID) return null;
  const all = (await file.indexesOf(t.name)).filter((ix) => ix.seekable && ix.columns[0]?.toLowerCase() === bookColumn.toLowerCase());
  const rank = (ix: IndexInfo) =>
    orderColumn === ROWID ? (ix.columns.length === 1 ? 0 : 1) : ix.columns[1]?.toLowerCase() === orderColumn.toLowerCase() ? 0 : 1;
  return all.sort((a, b) => rank(a) - rank(b) || a.columns.length - b.columns.length)[0] ?? null;
}

/** A mapping that names a VIRTUAL generated column would read NULL for every row: refuse it (review C12). */
async function refuseVirtualColumns(file: SqliteFile, m: DbMapping): Promise<void> {
  const uses: [string | undefined, (string | undefined)[]][] = [
    [m.lines.table, [m.lines.book, m.lines.order, m.lines.text, m.lines.heading, m.lines.path, ...(m.lines.orderThen ?? [])]],
    [m.books?.table, [m.books?.id, m.books?.title, m.books?.path, m.books?.category]],
    [m.links?.table, [m.links?.source, m.links?.target, m.links?.type]],
    [m.via?.table, [m.via?.id, m.via?.book, m.via?.order, m.via?.title]],
  ];
  for (const [table, cols] of uses) {
    const t = table ? await file.table(table) : null;
    if (!t) continue;
    for (const name of cols) {
      const c = name ? t.columns.find((x) => x.name.toLowerCase() === name.toLowerCase()) : undefined;
      if (c?.generated === "virtual") throw new LinkerError("db/mapping-invalid", virtualColumnMessage(t.name, c.name));
    }
  }
}

function colIndex(t: TableInfo, name: string): number {
  const i = t.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
  return i === -1 ? -3 : i;
}

function missing(table: string, column: string): LinkerError {
  return new LinkerError("db/mapping-invalid", `העמודה "${column}" אינה קיימת בטבלה "${table}". בדקו את המיפוי.`);
}
