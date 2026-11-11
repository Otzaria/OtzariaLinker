/*
 * Read-only SQLite reader that works directly on file pages (fileformat2.html), for databases too
 * large to load into sql.js (seforim.db is 4+ GB). Only the pages a query touches are read.
 *
 * Supports: page sizes 512–65536, reserved bytes, UTF-8/16 text, overflow pages, rowid tables,
 * WITHOUT ROWID tables, indexes, rowid-alias columns, ALTER TABLE ADD COLUMN defaults.
 * Seeks: rowid lookup/range on tables, key-prefix equality on indexes and WITHOUT ROWID tables
 * (BINARY collation, ascending keys — anything else falls back to a filtered scan by the caller).
 * Never writes. A database in WAL mode is reported, because uncheckpointed changes in the -wal
 * file are invisible to a page reader.
 */
import type { ByteSource } from "./byte-source";
import { parseCreateIndex, parseCreateTable, type ColumnDef, type IndexDef, type TableDef } from "./ddl";
import { compareValues, decodeRecord, readVarint, type SqlValue, type TextEncodingId } from "./record";

export interface SqliteHeader {
  pageSize: number;
  usableSize: number;
  pageCount: number;
  encoding: TextEncodingId;
  /** journal mode WAL (file format versions 2/2) */
  wal: boolean;
  schemaFormat: number;
}

export interface SchemaEntry {
  type: "table" | "index" | "view" | "trigger";
  name: string;
  tblName: string;
  rootPage: number;
  sql: string | null;
}

export interface TableInfo extends TableDef {
  name: string;
  rootPage: number;
}

export interface IndexInfo extends IndexDef {
  name: string;
  rootPage: number;
}

export interface Row {
  rowid: number | null;
  /** values aligned to the table's declared columns */
  values: SqlValue[];
}

const enum PageType { IndexInterior = 2, TableInterior = 5, IndexLeaf = 10, TableLeaf = 13 }

interface Page {
  type: PageType;
  /** absolute offsets (within the page buffer) of the cells, in key order */
  cells: number[];
  rightChild: number;
  data: Uint8Array;
}

export class SqliteFormatError extends Error {
  override readonly name = "SqliteFormatError";
}

export class SqliteFile {
  private readonly cache = new Map<number, Uint8Array>();
  private cacheBytes = 0;
  private schemaCache?: SchemaEntry[];
  /** number of pages read from the source (for diagnostics and performance tests) */
  pagesRead = 0;

  private constructor(
    private readonly src: ByteSource,
    readonly header: SqliteHeader,
    private readonly cacheBudget: number,
  ) {}

  static async open(src: ByteSource, opts: { cacheBytes?: number } = {}): Promise<SqliteFile> {
    if (src.size < 512) throw new SqliteFormatError("הקובץ קטן מכדי להיות מסד SQLite.");
    const h = await src.read(0, 100);
    if (new TextDecoder().decode(h.subarray(0, 15)) !== "SQLite format 3")
      throw new SqliteFormatError("הקובץ אינו מסד SQLite.");
    const dv = new DataView(h.buffer, h.byteOffset, 100);
    const raw = dv.getUint16(16);
    const pageSize = raw === 1 ? 65536 : raw;
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0)
      throw new SqliteFormatError(`גודל עמוד לא תקין במסד (${raw}).`);
    const reserved = h[20]!;
    const changeCounter = dv.getUint32(24);
    const validFor = dv.getUint32(92);
    const declaredPages = dv.getUint32(28);
    const pageCount = declaredPages && changeCounter === validFor ? declaredPages : Math.floor(src.size / pageSize);
    const enc = dv.getUint32(56) || 1;
    if (enc < 1 || enc > 3) throw new SqliteFormatError(`קידוד טקסט לא מוכר במסד (${enc}).`);
    const header: SqliteHeader = {
      pageSize,
      usableSize: pageSize - reserved,
      pageCount,
      encoding: enc as TextEncodingId,
      wal: h[18] === 2 || h[19] === 2,
      schemaFormat: dv.getUint32(44),
    };
    return new SqliteFile(src, header, opts.cacheBytes ?? 32 * 1024 ** 2);
  }

  // ---- schema ----------------------------------------------------------------------------

  async schema(): Promise<SchemaEntry[]> {
    if (this.schemaCache) return this.schemaCache;
    const out: SchemaEntry[] = [];
    for await (const { values: v } of this.walkTable(1, null, null)) {
      out.push({ type: v[0] as SchemaEntry["type"], name: String(v[1]), tblName: String(v[2]), rootPage: Number(v[3] ?? 0), sql: (v[4] as string | null) ?? null });
    }
    this.schemaCache = out;
    return out;
  }

  async table(name: string): Promise<TableInfo | null> {
    const e = (await this.schema()).find((x) => x.type === "table" && x.name.toLowerCase() === name.toLowerCase());
    if (!e?.sql) return null;
    return { name: e.name, rootPage: e.rootPage, ...parseCreateTable(e.sql) };
  }

  /**
   * Indexes of a table, including SQLite's automatic ones (sqlite_autoindex_<table>_<n>, stored with
   * no SQL). An automatic index #1 of a table whose PRIMARY KEY is not the rowid covers the key
   * columns; other automatic indexes (UNIQUE constraints) are listed but not seekable.
   */
  async indexesOf(table: string): Promise<IndexInfo[]> {
    const t = await this.table(table);
    return (await this.schema())
      .filter((x) => x.type === "index" && x.tblName.toLowerCase() === table.toLowerCase() && x.rootPage)
      .map((x): IndexInfo => {
        if (x.sql) return { name: x.name, rootPage: x.rootPage, ...parseCreateIndex(x.sql) };
        const pkIsKey = !!t && !t.withoutRowid && t.primaryKey.length > 0 && !t.columns.some((c) => c.rowidAlias);
        const first = /^sqlite_autoindex_.+_1$/.test(x.name);
        return { name: x.name, rootPage: x.rootPage, table: x.tblName, columns: first && pkIsKey ? [...t!.primaryKey] : [], seekable: first && pkIsKey };
      });
  }

  /** The first seekable index whose leading columns are exactly `columns` (case-insensitive). */
  async findIndex(table: string, columns: readonly string[]): Promise<IndexInfo | null> {
    const want = columns.map((c) => c.toLowerCase());
    return (await this.indexesOf(table)).find((ix) => ix.seekable && want.every((c, i) => ix.columns[i]?.toLowerCase() === c)) ?? null;
  }

  /**
   * Many rows by rowid in one ordered walk: each page is visited at most once and only subtrees that
   * contain a wanted rowid are entered. Missing rowids are simply absent from the result.
   */
  async getMany(t: TableInfo, rowids: Iterable<number>): Promise<Map<number, Row>> {
    const ids = [...new Set(rowids)].sort((a, b) => a - b);
    const out = new Map<number, Row>();
    if (ids.length) await this.collectRows(t, t.rootPage, ids, 0, ids.length, out);
    return out;
  }

  private async collectRows(t: TableInfo, pageNo: number, ids: number[], lo: number, hi: number, out: Map<number, Row>): Promise<void> {
    const page = await this.page(pageNo);
    if (page.type === PageType.TableLeaf) {
      let k = lo;
      for (const off of page.cells) {
        if (k >= hi) return;
        const [size, n1] = readVarint(page.data, off);
        const [rowid, n2] = readVarint(page.data, off + n1);
        while (k < hi && ids[k]! < rowid) k++;
        if (k < hi && ids[k] === rowid) {
          const payload = await this.payload(page.data, off + n1 + n2, size, false);
          out.set(rowid, { rowid, values: this.alignRow(t.columns, rowid, decodeRecord(payload, this.header.encoding)) });
          k++;
        }
      }
      return;
    }
    if (page.type !== PageType.TableInterior) throw new SqliteFormatError(`עמוד ${pageNo} אינו עמוד טבלה.`);
    let k = lo;
    for (const off of page.cells) {
      if (k >= hi) return;
      const [key] = readVarint(page.data, off + 4);
      let j = k;
      while (j < hi && ids[j]! <= key) j++;
      if (j > k) await this.collectRows(t, readU32(page.data, off), ids, k, j, out);
      k = j;
    }
    if (k < hi) await this.collectRows(t, page.rightChild, ids, k, hi, out);
  }

  // ---- table access ----------------------------------------------------------------------

  /** All rows of a rowid table in rowid order, optionally limited to [from, to]. */
  async *scan(t: TableInfo, range: { from?: number; to?: number } = {}): AsyncGenerator<Row> {
    if (t.withoutRowid) {
      for await (const rec of this.walkIndex(t.rootPage, null)) yield { rowid: null, values: this.withoutRowidRow(t, rec) };
      return;
    }
    for await (const r of this.walkTable(t.rootPage, range.from ?? null, range.to ?? null)) yield { rowid: r.rowid, values: this.alignRow(t.columns, r.rowid, r.values) };
  }

  async get(t: TableInfo, rowid: number): Promise<Row | null> {
    for await (const r of this.walkTable(t.rootPage, rowid, rowid)) return { rowid: r.rowid, values: this.alignRow(t.columns, r.rowid, r.values) };
    return null;
  }

  /** Rows of a WITHOUT ROWID table whose primary key starts with `prefix`, in key order. */
  async *seekPrimaryKey(t: TableInfo, prefix: SqlValue[]): AsyncGenerator<Row> {
    if (!t.withoutRowid) throw new Error("seekPrimaryKey is for WITHOUT ROWID tables");
    for await (const rec of this.walkIndex(t.rootPage, prefix)) yield { rowid: null, values: this.withoutRowidRow(t, rec) };
  }

  /**
   * Index entries whose leading key columns equal `prefix`, in index order. Each entry is the raw
   * index record: [key columns…, rowid]. Reading a column from the index record avoids touching
   * the table at all (e.g. lineIndex from idx_line_book_index).
   */
  async *seekIndex(ix: IndexInfo, prefix: SqlValue[]): AsyncGenerator<SqlValue[]> {
    if (!ix.seekable) throw new Error(`index ${ix.name} is not seekable (collation/DESC/expression)`);
    yield* this.walkIndex(ix.rootPage, prefix);
  }

  private alignRow(columns: ColumnDef[], rowid: number, rec: SqlValue[]): SqlValue[] {
    return columns.map((c, i) => (c.rowidAlias ? rowid : i < rec.length ? rec[i]! : c.defaultValue));
  }

  /** WITHOUT ROWID records store the primary-key columns first, then the others in declared order. */
  private withoutRowidRow(t: TableInfo, rec: SqlValue[]): SqlValue[] {
    const pk = t.primaryKey.map((n) => n.toLowerCase());
    const order = [...pk.map((n) => t.columns.findIndex((c) => c.name.toLowerCase() === n)), ...t.columns.map((_, i) => i).filter((i) => !pk.includes(t.columns[i]!.name.toLowerCase()))];
    const out = new Array<SqlValue>(t.columns.length).fill(null);
    order.forEach((colIdx, recIdx) => { out[colIdx] = recIdx < rec.length ? rec[recIdx]! : t.columns[colIdx]!.defaultValue; });
    return out;
  }

  // ---- b-tree walking --------------------------------------------------------------------

  private async *walkTable(pageNo: number, from: number | null, to: number | null): AsyncGenerator<{ rowid: number; values: SqlValue[] }> {
    const page = await this.page(pageNo);
    if (page.type === PageType.TableLeaf) {
      for (const off of page.cells) {
        const [size, n1] = readVarint(page.data, off);
        const [rowid, n2] = readVarint(page.data, off + n1);
        if (from !== null && rowid < from) continue;
        if (to !== null && rowid > to) return;
        const payload = await this.payload(page.data, off + n1 + n2, size, false);
        yield { rowid, values: decodeRecord(payload, this.header.encoding) };
      }
      return;
    }
    if (page.type !== PageType.TableInterior) throw new SqliteFormatError(`עמוד ${pageNo} אינו עמוד טבלה.`);
    for (const off of page.cells) {
      const child = readU32(page.data, off);
      const [key] = readVarint(page.data, off + 4); // every rowid in `child` is <= key
      if (from !== null && key < from) continue;
      yield* this.walkTable(child, from, to);
      if (to !== null && key >= to) return;
    }
    yield* this.walkTable(page.rightChild, from, to);
  }

  /** In-order walk of an index b-tree; with a prefix, only matching records and only the pages that can hold them. */
  private async *walkIndex(pageNo: number, prefix: SqlValue[] | null): AsyncGenerator<SqlValue[]> {
    const state = { done: false };
    yield* this.walkIndexInner(pageNo, prefix, state);
  }

  private async *walkIndexInner(pageNo: number, prefix: SqlValue[] | null, state: { done: boolean }): AsyncGenerator<SqlValue[]> {
    const page = await this.page(pageNo);
    const leaf = page.type === PageType.IndexLeaf;
    if (!leaf && page.type !== PageType.IndexInterior) throw new SqliteFormatError(`עמוד ${pageNo} אינו עמוד אינדקס.`);
    const record = async (i: number) => {
      const off = page.cells[i]!;
      const at = leaf ? off : off + 4;
      const [size, n] = readVarint(page.data, at);
      return decodeRecord(await this.payload(page.data, at + n, size, true), this.header.encoding);
    };
    // With a prefix, binary-search the first cell whose key is >= prefix: every earlier cell (and
    // its left subtree) holds only smaller keys. This keeps a seek at O(log cells) decodes per page.
    let first = 0;
    if (prefix) {
      let lo = 0;
      let hi = page.cells.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (comparePrefix(await record(mid), prefix) < 0) lo = mid + 1;
        else hi = mid;
      }
      first = lo;
    }
    for (let i = first; i < page.cells.length; i++) {
      const off = page.cells[i]!;
      const rec = await record(i);
      const cmp = prefix ? comparePrefix(rec, prefix) : 0;
      if (!leaf && cmp >= 0) {
        // entries in the left child are <= this key, so they may still match
        yield* this.walkIndexInner(readU32(page.data, off), prefix, state);
        if (state.done) return;
      }
      if (cmp === 0) yield rec;
      else if (cmp > 0) { state.done = true; return; }
    }
    if (!leaf) yield* this.walkIndexInner(page.rightChild, prefix, state);
  }

  // ---- pages and payloads ----------------------------------------------------------------

  private async page(no: number): Promise<Page> {
    if (no < 1 || no > Math.max(this.header.pageCount, 1) + 1) throw new SqliteFormatError(`הפניה לעמוד ${no} שאינו קיים — ייתכן שהמסד פגום.`);
    const data = await this.rawPage(no);
    const h = no === 1 ? 100 : 0;
    const type = data[h] as PageType;
    const interior = type === PageType.IndexInterior || type === PageType.TableInterior;
    const count = (data[h + 3]! << 8) | data[h + 4]!;
    const ptrs = h + (interior ? 12 : 8);
    const cells = new Array<number>(count);
    for (let i = 0; i < count; i++) cells[i] = (data[ptrs + 2 * i]! << 8) | data[ptrs + 2 * i + 1]!;
    return { type, cells, rightChild: interior ? readU32(data, h + 8) : 0, data };
  }

  private async rawPage(no: number): Promise<Uint8Array> {
    const hit = this.cache.get(no);
    if (hit) {
      this.cache.delete(no);
      this.cache.set(no, hit); // LRU: move to the end
      return hit;
    }
    const size = this.header.pageSize;
    const data = await this.src.read((no - 1) * size, size);
    if (data.length < size) throw new SqliteFormatError(`עמוד ${no} חתוך — הקובץ אינו שלם.`);
    this.pagesRead++;
    this.cache.set(no, data);
    this.cacheBytes += size;
    while (this.cacheBytes > this.cacheBudget && this.cache.size > 1) {
      const oldest = this.cache.keys().next().value as number;
      this.cache.delete(oldest);
      this.cacheBytes -= size;
    }
    return data;
  }

  /** Payload bytes of a cell, following overflow pages when the payload does not fit locally. */
  private async payload(page: Uint8Array, at: number, size: number, index: boolean): Promise<Uint8Array> {
    const U = this.header.usableSize;
    const X = index ? Math.floor(((U - 12) * 64) / 255) - 23 : U - 35;
    if (size <= X) return page.subarray(at, at + size);
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    const K = M + ((size - M) % (U - 4));
    const local = K <= X ? K : M;
    const out = new Uint8Array(size);
    out.set(page.subarray(at, at + local));
    let filled = local;
    let next = readU32(page, at + local);
    while (filled < size) {
      if (!next) throw new SqliteFormatError("שרשרת עמודי ההמשך קטועה — ייתכן שהמסד פגום.");
      const ov = await this.rawPage(next);
      const take = Math.min(U - 4, size - filled);
      out.set(ov.subarray(4, 4 + take), filled);
      filled += take;
      next = readU32(ov, 0);
    }
    return out;
  }
}

function readU32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
}

function comparePrefix(rec: SqlValue[], prefix: SqlValue[]): number {
  for (let i = 0; i < prefix.length; i++) {
    const c = compareValues(rec[i] ?? null, prefix[i]!);
    if (c) return c;
  }
  return 0;
}
