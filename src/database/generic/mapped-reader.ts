import { ROWID, type DbMapping } from "../../core/db-mapping";
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
 *     discovered, or a links table that needs every line id). ONE sequential pass over the lines
 *     table — or over a narrower index that has the book column first — builds the locators of every
 *     book, with progress and cancel. Memory: one number per line (8 bytes).
 *
 * WITHOUT ROWID lines tables are read when their primary key starts with (book, order): the locator
 * is then the list of order values, and chunks are fetched with one ordered multi-seek.
 */
export interface MappedBook {
  /** position in `books` — the id inside the source */
  n: number;
  title: string;
  path: string | null;
  /** known after a scan; null with the "index" strategy until the book is read */
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
}

type Locator = { kind: "rowid"; ids: Float64Array } | { kind: "pk"; orders: SqlValue[] };

const MAX_BOOKS = 1_000_000;
const MAX_LINKS = 5_000_000;
const CACHE_LINES = 4_000_000;

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
  private readonly bookValue: SqlValue[] = [];
  private readonly locators = new Map<number, Locator>();
  private cachedLines = 0;
  private links: LinkIndex | null = null;
  private readonly codec = new GenericTextCodec();
  private readonly col: { book: number; order: number; text: number; heading: number; path: number };

  private constructor(
    private readonly file: SqliteFile,
    private readonly m: DbMapping,
    private readonly t: TableInfo,
    readonly strategy: "index" | "scan",
    private readonly ix: IndexInfo | null,
  ) {
    const at = (name: string | undefined) => (name === undefined ? -2 : name === ROWID ? -1 : colIndex(t, name));
    this.col = { book: at(m.lines.book), order: at(m.lines.order), text: at(m.lines.text), heading: at(m.lines.heading), path: m.layout === "single-table" ? at(m.lines.path) : -2 };
    for (const [k, v] of Object.entries(this.col)) if (v === -3) throw missing(t.name, String(m.lines[k as keyof DbMapping["lines"]]));
  }

  static async open(file: SqliteFile, m: DbMapping, ctx: ReadContext = {}): Promise<MappedDbReader> {
    const t = await file.table(m.lines.table);
    if (!t) throw new LinkerError("db/mapping-invalid", `הטבלה "${m.lines.table}" אינה קיימת במסד. בדקו את המיפוי.`);
    if (t.withoutRowid) {
      const pk = t.primaryKey.map((x) => x.toLowerCase());
      if (pk[0] !== m.lines.book.toLowerCase() || pk[1] !== m.lines.order.toLowerCase())
        throw new LinkerError("db/mapping-invalid", `הטבלה "${t.name}" היא WITHOUT ROWID, והכלי קורא אותה רק כשהמפתח הראשי שלה מתחיל ב(${m.lines.book}, ${m.lines.order}).`);
      if (m.links) throw new LinkerError("db/mapping-invalid", "קישורים נקראים לפי מזהה השורה (rowid), ולטבלת השורות אין rowid.");
    }
    const ix = t.withoutRowid ? null : await bookIndex(file, t, m.lines.book, m.lines.order);
    const lazy = m.layout === "two-tables" && !m.links && (t.withoutRowid || ix !== null);
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

  /* ---------------- lines ---------------- */

  /**
   * One pass that builds the locator of every book. Reads the narrow index (book first) when it has
   * the order too and nothing else is needed from the rows; otherwise the table itself.
   */
  private async scanLines(ctx: ReadContext): Promise<void> {
    const single = this.m.layout === "single-table";
    const byKey = new Map<string, number>();
    if (!single) this.bookValue.forEach((v, n) => byKey.set(keyOf(v), n));
    const ids: number[][] = [];
    const orders: SqlValue[][] = [];
    const orderIsRowid = this.col.order === -1;
    let orphans = 0;
    let sorted = true;

    const add = (bookVal: SqlValue, order: SqlValue, rowid: number, row: Row | null) => {
      const k = keyOf(bookVal);
      let n = byKey.get(k);
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

    const ixOrder = this.ix ? this.ix.columns.findIndex((c, i) => i > 0 && c.toLowerCase() === this.m.lines.order.toLowerCase()) : -1;
    const fromIndex = this.ix !== null && this.col.path < 0 && (orderIsRowid ? this.ix.columns.length === 1 : ixOrder === 1);
    if (this.t.withoutRowid) {
      // primary-key order is (book, order): every book's rows come together and already sorted
      await this.each(this.file.scan(this.t), await this.file.leafCount(this.t.rootPage), ctx, (row, i) => add(row.values[this.col.book]!, row.values[this.col.order]!, i, row));
    } else if (fromIndex) {
      // entries [book, (order,) rowid] in key order — already sorted inside each book
      await this.each(this.file.seekIndex(this.ix!, []), await this.file.leafCount(this.ix!.rootPage), ctx, (rec) => add(rec[0]!, orderIsRowid ? null : rec[1]!, Number(rec[rec.length - 1]), null));
    } else {
      await this.each(this.file.scan(this.t), await this.file.leafCount(this.t.rootPage), ctx, (row) => add(row.values[this.col.book]!, orderIsRowid ? null : this.orderOf(row), row.rowid!, row));
      sorted = orderIsRowid; // a table scan is in rowid order
    }
    for (const b of this.books) {
      const list = ids[b.n] ?? [];
      if (this.t.withoutRowid) this.store(b.n, { kind: "pk", orders: orders[b.n] ?? [] });
      else this.store(b.n, { kind: "rowid", ids: sorted ? Float64Array.from(list) : sortByOrder(list, orders[b.n] ?? []) });
      b.lineCount = list.length;
    }
    if (orphans)
      this.warnings.push({ code: "db/mapping-orphan-lines", message: `${orphans.toLocaleString("he")} שורות לא שייכות לאף ספר בטבלת הספרים (או שהעמודה שלהן ריקה), ולכן לא יוצגו.` });
  }

  private orderOf(row: Row): SqlValue {
    return this.col.order === -1 ? row.rowid : row.values[this.col.order]!;
  }

  /** Lines [from, to] (0-based positions, inclusive) of a book. */
  async lines(n: number, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<MappedLine[]> {
    const loc = await this.locatorOf(n);
    const count = loc.kind === "rowid" ? loc.ids.length : loc.orders.length;
    const a = Math.max(0, from);
    const b = Math.min(count - 1, to);
    if (b < a) return [];
    const rows: (Row | undefined)[] = [];
    if (loc.kind === "rowid") {
      const want = Array.from(loc.ids.subarray(a, b + 1));
      const got = await this.file.getMany(this.t, want);
      for (const id of want) rows.push(got.get(id));
    } else {
      const bookVal = this.bookValue[n]!;
      const got = await this.file.seekPrimaryKeyMany(this.t, loc.orders.slice(a, b + 1).map((o) => [bookVal, o]));
      let k = 0;
      for (let i = a; i <= b; i++) {
        while (k < got.length && compareValues(got[k]!.values[this.col.order]!, loc.orders[i]!) < 0) k++;
        rows.push(k < got.length && compareValues(got[k]!.values[this.col.order]!, loc.orders[i]!) === 0 ? got[k++] : undefined);
      }
    }
    return rows.map((row, i) => {
      let text = "";
      try {
        text = row ? (this.codec.decode(row.values[this.col.text]) ?? "") : "";
      } catch {
        this.undecodable++;
      }
      return { index: a + i, text, heading: this.headingOf(row, text) };
    });
  }

  async lineCount(n: number): Promise<number> {
    const loc = await this.locatorOf(n);
    return loc.kind === "rowid" ? loc.ids.length : loc.orders.length;
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
    if (loc.kind === "rowid" ? !loc.ids.length : !loc.orders.length) {
      const alt = altForm(this.bookValue[n]!);
      if (alt !== undefined) {
        const other = await this.readLocator(alt);
        if (other.kind === "rowid" ? other.ids.length : other.orders.length) this.bookValue[n] = alt;
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
      const orders: SqlValue[] = [];
      for await (const r of this.file.seekPrimaryKey(this.t, [bookVal])) orders.push(r.values[this.col.order]!);
      return { kind: "pk", orders };
    }
    const ix = this.ix!;
    const ids: number[] = [];
    const ord: SqlValue[] = [];
    const k = ix.columns.findIndex((c, i) => i > 0 && c.toLowerCase() === this.m.lines.order.toLowerCase());
    for await (const rec of this.file.seekIndex(ix, [bookVal])) {
      ids.push(Number(rec[rec.length - 1]));
      if (k > 0) ord.push(rec[k]!);
    }
    if (this.col.order === -1) return { kind: "rowid", ids: k === -1 && ix.columns.length === 1 ? Float64Array.from(ids) : Float64Array.from(ids).sort() };
    if (k === 1) return { kind: "rowid", ids: Float64Array.from(ids) };
    if (k > 1) return { kind: "rowid", ids: sortByOrder(ids, ord) };
    // the order column is not in the index: read the book's rows once to learn it
    const rows = await this.file.getMany(this.t, ids);
    return { kind: "rowid", ids: sortByOrder(ids, ids.map((id) => (rows.has(id) ? this.orderOf(rows.get(id)!) : null))) };
  }

  private store(n: number, loc: Locator): void {
    const size = loc.kind === "rowid" ? loc.ids.length : loc.orders.length;
    this.locators.set(n, loc);
    this.cachedLines += size;
    if (this.strategy !== "index") return;
    while (this.cachedLines > CACHE_LINES && this.locators.size > 1) {
      const [oldest, l] = this.locators.entries().next().value as [number, Locator];
      this.locators.delete(oldest);
      this.cachedLines -= l.kind === "rowid" ? l.ids.length : l.orders.length;
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
   * than its pages can hold shares pages between parents — corrupt or hostile.
   */
  private async each<T>(it: AsyncIterable<T>, leaves: number, ctx: ReadContext, fn: (x: T, i: number) => void): Promise<void> {
    const start = this.file.pagesRead;
    const maxRows = Math.max(1, this.file.header.pageCount) * Math.floor(this.file.header.pageSize / 2);
    let i = 0;
    let lastYield = Date.now();
    for await (const x of it) {
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

/** Positions sorted by (order, rowid); returns the rowids in that order. */
function sortByOrder(ids: number[], orders: SqlValue[]): Float64Array {
  const perm = Array.from(ids.keys());
  const allNumbers = orders.every((o) => typeof o === "number");
  if (allNumbers) {
    const o = orders as number[];
    perm.sort((a, b) => o[a]! - o[b]! || ids[a]! - ids[b]!);
  } else perm.sort((a, b) => compareValues(orders[a] ?? null, orders[b] ?? null) || ids[a]! - ids[b]!);
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

function colIndex(t: TableInfo, name: string): number {
  const i = t.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
  return i === -1 ? -3 : i;
}

function missing(table: string, column: string): LinkerError {
  return new LinkerError("db/mapping-invalid", `העמודה "${column}" אינה קיימת בטבלה "${table}". בדקו את המיפוי.`);
}
