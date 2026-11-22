import { CONNECTION_TYPES, parseConnectionType } from "../../core/links/connection-type";
import type { IndexInfo, SqliteFile, TableInfo } from "../sqlite/lazy/sqlite-file";
import type { DbCapabilities } from "./capabilities";

/*
 * The links of a PERSONAL database that has no `link` table (Personal-DB-Creator): they live in
 * `external_link`, one row per link, with no id, no anchors, no ranges and no hidden sides
 * (docs/research/PERSONAL_DB_V52_AUDIT.md §4, DATABASE_SUPPORT_MATRIX §5.3). A row says:
 *
 *   sourceBookId, sourceLineIndex   a book of THIS database, and its 0-based line
 *   targetSource                    'official' (the library) | the database's own library_id (itself) | another
 *                                   attached database's library_id | NULL (any: the library first)
 *   targetTitle                     the target book, by exact title — the book may be in ANOTHER source
 *   targetRef                       the heRef of the target line (preferred), else targetLineIndex (0-based)
 *   connectionType                  free TEXT with the meaning of the official table's type; NULL = REFERENCE.
 *                                   SOURCE = the target is the BASE of the source book (stored dependent → base,
 *                                   the reverse of the official storage)
 *
 * Read-only and lazy like every reader (AGENTS §2.3): the outgoing links of a book come from
 * idx_external_link_source (a seek, no scan); there is no index on the target, so the links INTO a book from
 * its own database need one scan of the table, kept as compact arrays (`InternalLinks`) and built on demand.
 * The row id is the rowid; the tool's link id is `<source id>:ext:<rowid>`.
 */
export interface ExternalLinkRow {
  rowid: number;
  bookId: number;
  lineIndex: number;
  targetSource: string | null;
  targetTitle: string;
  targetRef: string | null;
  targetLine: number | null;
  /** the stored text; null = REFERENCE */
  typeName: string | null;
}

/** Links whose target is a book of the same database, as parallel arrays sorted by target book (≈ 725K rows in a real one: ~20 MB). */
export interface InternalLinks {
  readonly rowid: Float64Array;
  readonly sourceBook: Int32Array;
  readonly sourceLine: Int32Array;
  readonly targetBook: Int32Array;
  readonly targetLine: Int32Array;
  /** index into CONNECTION_TYPES */
  readonly type: Uint8Array;
  /**
   * 1 when the row has no targetSource ("any source, the library first"): it reaches this database's book only if
   * the library does not have that title — the registry decides when the links are listed, never the scan
   */
  readonly viaNull: Uint8Array;
  /** 1 when the same two lines are also linked the other way round (a reversed record is a duplicate link, AGENTS §3) */
  readonly reverse: Uint8Array;
  /** the position of a row in these arrays by its rowid, or -1 (it is not an internal row) */
  positionOf(rowid: number): number;
  /** first and last+1 position of a target book's rows */
  readonly range: ReadonlyMap<number, readonly [number, number]>;
  /** rows whose target line is unknown (no targetLineIndex): left out */
  readonly skipped: number;
}

/** below this many lines a range is read with one seek per line; above, the book's rows are read and filtered */
const SEEK_LINES = 400;
const BATCH = 20_000;

export class ExternalLinksReader {
  private constructor(
    private readonly file: SqliteFile,
    private readonly t: TableInfo,
    private readonly c: { book: number; line: number; source: number; title: number; ref: number; target: number; type: number },
    private readonly ix: IndexInfo | null,
  ) {}

  /** null when the database has no usable external_link (the table, or its three required columns, are missing) */
  static async open(file: SqliteFile, caps: DbCapabilities): Promise<ExternalLinksReader | null> {
    if (!caps.externalLinks) return null;
    const t = await file.table("external_link");
    if (!t) return null;
    const at = (n: string) => t.columns.findIndex((x) => x.name.toLowerCase() === n.toLowerCase());
    const c = { book: at("sourceBookId"), line: at("sourceLineIndex"), source: at("targetSource"), title: at("targetTitle"), ref: at("targetRef"), target: at("targetLineIndex"), type: at("connectionType") };
    if (c.book < 0 || c.line < 0 || c.title < 0) return null;
    return new ExternalLinksReader(file, t, c, await file.findIndex("external_link", ["sourceBookId"]));
  }

  /** whether a book's links are read by a seek (idx_external_link_source) rather than a scan of the table */
  get indexed(): boolean {
    return !!this.ix;
  }

  private row(rowid: number, v: readonly unknown[]): ExternalLinkRow {
    const str = (i: number) => (i < 0 || v[i] === null || v[i] === undefined ? null : String(v[i]));
    const num = (i: number) => (i < 0 || v[i] === null || v[i] === undefined ? null : Number(v[i]));
    return {
      rowid,
      bookId: Number(v[this.c.book]),
      lineIndex: Number(v[this.c.line]),
      targetSource: str(this.c.source),
      targetTitle: String(v[this.c.title] ?? ""),
      targetRef: str(this.c.ref),
      targetLine: num(this.c.target),
      typeName: str(this.c.type),
    };
  }

  async byRowids(ids: Iterable<number>): Promise<ExternalLinkRow[]> {
    const got = await this.file.getMany(this.t, ids);
    return [...got].sort((a, b) => a[0] - b[0]).map(([id, r]) => this.row(id, r.values));
  }

  /** Every link that starts in a book (from the index; a scan when the table has none), in batches that report progress and can be cancelled. */
  async outgoing(bookId: number, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}): Promise<ExternalLinkRow[]> {
    const out: ExternalLinkRow[] = [];
    if (this.ix) {
      const ids: number[] = [];
      for await (const rec of this.file.seekIndex(this.ix, [bookId])) ids.push(Number(rec.at(-1)));
      ids.sort((a, b) => a - b);
      for (let i = 0; i < ids.length; i += BATCH) {
        ctx.signal?.throwIfAborted();
        out.push(...(await this.byRowids(ids.slice(i, i + BATCH))));
        ctx.progress?.(Math.min(i + BATCH, ids.length), ids.length);
      }
      return out;
    }
    let n = 0;
    for await (const r of this.file.scan(this.t)) {
      if (++n % 50_000 === 0) ctx.signal?.throwIfAborted();
      if (Number(r.values[this.c.book]) === bookId) out.push(this.row(Number(r.rowid), r.values));
    }
    return out;
  }

  /** The links that start on the lines [from, to] of a book: one seek per line for a short range, else the book's rows filtered. */
  async atLines(bookId: number, from: number, to: number): Promise<ExternalLinkRow[]> {
    if (this.ix && to - from < SEEK_LINES) {
      const keys: number[][] = [];
      for (let i = Math.max(0, from); i <= to; i++) keys.push([bookId, i]);
      const recs = await this.file.seekIndexMany(this.ix, keys);
      return this.byRowids(recs.map((r) => Number(r.at(-1))));
    }
    return (await this.outgoing(bookId)).filter((r) => r.lineIndex >= from && r.lineIndex <= to);
  }

  /**
   * One scan of the table for the links whose target may be a book of this same database: `targetSource` is the
   * database's own library_id, or NULL (any source — flagged `viaNull`, see InternalLinks), and the title is one of
   * its books (`titles`: title → book id). Rows to the library ('official') or to other databases are not in it;
   * rows with no targetLineIndex are counted in `skipped`.
   */
  async internal(libraryId: string | undefined, titles: ReadonlyMap<string, number>, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}): Promise<InternalLinks> {
    const cap = { rowid: [] as number[], sb: [] as number[], sl: [] as number[], tb: [] as number[], tl: [] as number[], ty: [] as number[], nul: [] as number[] };
    let skipped = 0;
    let n = 0;
    {
      for await (const r of this.file.scan(this.t)) {
        if (++n % 50_000 === 0) ctx.signal?.throwIfAborted();
        const v = r.values;
        const source = this.c.source < 0 ? null : (v[this.c.source] ?? null);
        if (source !== null && source !== libraryId) continue;
        const tb = titles.get(String(v[this.c.title]));
        if (tb === undefined) continue;
        if (this.c.target < 0 || v[this.c.target] === null || v[this.c.target] === undefined) {
          skipped++;
          continue;
        }
        cap.rowid.push(Number(r.rowid));
        cap.sb.push(Number(v[this.c.book]));
        cap.sl.push(Number(v[this.c.line]));
        cap.tb.push(tb);
        cap.tl.push(Number(v[this.c.target]));
        cap.nul.push(source === null ? 1 : 0);
        cap.ty.push(CONNECTION_TYPES.indexOf(this.typeOf(this.c.type < 0 ? null : (v[this.c.type] as string | null))));
      }
    }
    const order = Int32Array.from(cap.tb.keys()).sort((a, b) => cap.tb[a]! - cap.tb[b]! || cap.rowid[a]! - cap.rowid[b]!);
    const m = order.length;
    const out = { rowid: new Float64Array(m), sourceBook: new Int32Array(m), sourceLine: new Int32Array(m), targetBook: new Int32Array(m), targetLine: new Int32Array(m), type: new Uint8Array(m), viaNull: new Uint8Array(m) };
    const range = new Map<number, [number, number]>();
    order.forEach((from, i) => {
      out.rowid[i] = cap.rowid[from]!;
      out.sourceBook[i] = cap.sb[from]!;
      out.sourceLine[i] = cap.sl[from]!;
      out.targetBook[i] = cap.tb[from]!;
      out.targetLine[i] = cap.tl[from]!;
      out.type[i] = cap.ty[from]!;
      out.viaNull[i] = cap.nul[from]!;
      const r = range.get(cap.tb[from]!);
      if (r) r[1] = i + 1;
      else range.set(cap.tb[from]!, [i, i + 1]);
    });
    // the reversed pair: for each row, is there a row from its target line to its source line? (sorted, then a binary search)
    const cmp = (a: number, b: number) => out.sourceBook[a]! - out.sourceBook[b]! || out.sourceLine[a]! - out.sourceLine[b]! || out.targetBook[a]! - out.targetBook[b]! || out.targetLine[a]! - out.targetLine[b]!;
    const bySource = Int32Array.from({ length: m }, (_, i) => i).sort(cmp);
    const reverse = new Uint8Array(m);
    for (let i = 0; i < m; i++) {
      let lo = 0;
      let hi = m - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const j = bySource[mid]!;
        const c = out.sourceBook[j]! - out.targetBook[i]! || out.sourceLine[j]! - out.targetLine[i]! || out.targetBook[j]! - out.sourceBook[i]! || out.targetLine[j]! - out.sourceLine[i]!;
        if (c === 0) {
          reverse[i] = 1;
          break;
        }
        if (c < 0) lo = mid + 1;
        else hi = mid - 1;
      }
    }
    const byRowid = Int32Array.from({ length: m }, (_, i) => i).sort((a, b) => out.rowid[a]! - out.rowid[b]!);
    const positionOf = (rowid: number): number => {
      let lo = 0;
      let hi = m - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = out.rowid[byRowid[mid]!]!;
        if (v === rowid) return byRowid[mid]!;
        if (v < rowid) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    };
    return { ...out, reverse, positionOf, range, skipped };
  }

  /** NULL (or empty) is REFERENCE; every other text goes through the generator's parser (unknown → OTHER) */
  typeOf(name: string | null): (typeof CONNECTION_TYPES)[number] {
    return name === null || name.trim() === "" ? "REFERENCE" : parseConnectionType(name).type;
  }
}
