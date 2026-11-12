import { pushTo } from "../../core/collections";
import { LinkerError } from "../../core/errors";
import { LineContentCodec } from "../compression/zstd";
import type { ByteSource } from "../sqlite/lazy/byte-source";
import type { SqlValue } from "../sqlite/lazy/record";
import { SqliteFile, type TableInfo } from "../sqlite/lazy/sqlite-file";
import { detectCapabilities, type DbCapabilities } from "./capabilities";
import { rehydrateLine, type NoteAt } from "./line-notes";

/*
 * Read-only access to an Otzaria-family database of any schema (0–7), large or small, through the
 * lazy page reader. Lines are addressed by (bookId, lineIndex) — never by line.id, which is sparse,
 * non-contiguous and overlaps between databases (DATABASE_SUPPORT_MATRIX §6).
 */
export interface DbBook {
  id: number;
  title: string;
  source: string | null;
  categoryId: number | null;
  orderIndex: number | null;
  /** null when the database does not say */
  isBaseBook: boolean | null;
  /** as declared by the database; count lines with lineEntries() for the truth */
  totalLines: number | null;
  /** book.dependenceType (schema 2+), verbatim; null when absent */
  dependenceType: string | null;
}

export interface DbLine {
  index: number;
  lineId: number;
  heRef: string | null;
  /** the line as stored (footnote bodies of schema 7 are NOT in it) */
  content: string;
  /** schema-7 footnotes of this line, in noteIndex order (bodies decoded) */
  notes: NoteAt[];
}

export class OtzariaDbReader {
  private constructor(
    readonly file: SqliteFile,
    readonly caps: DbCapabilities,
    private readonly codec: LineContentCodec,
    private readonly t: { book: TableInfo; line: TableInfo; content: TableInfo | null; note: TableInfo | null; source: TableInfo | null },
  ) {}

  static async open(src: ByteSource): Promise<OtzariaDbReader> {
    const file = await SqliteFile.open(src);
    const caps = await detectCapabilities(file);
    const book = await file.table("book");
    const line = await file.table("line");
    if (!book || !line || caps.inferredSchema === null) throw new LinkerError("db/no-books", "במסד אין טבלאות ספרים ושורות במבנה של אוצריא. פתחו אותו בגרירה לחלון או מכפתור הקבצים: הכלי יציג את הטבלאות שלו ויבקש לבחור איפה הספרים ואיפה השורות.");
    const dicts: Uint8Array[] = [];
    if (caps.compressed) {
      for await (const r of file.scan((await file.table("zstd_dict"))!)) {
        const d = r.values[1];
        if (d instanceof Uint8Array) dicts.push(d);
      }
    }
    return new OtzariaDbReader(file, caps, new LineContentCodec(dicts, undefined, "מסד פתוח"), {
      book,
      line,
      content: caps.text === "line_content" ? await file.table("line_content") : null,
      note: caps.lineNotes ? await file.table("line_note") : null,
      source: caps.sources ? await file.table("source") : null,
    });
  }

  async books(): Promise<DbBook[]> {
    const sources = new Map<number, string>();
    if (this.t.source) {
      const nameAt = colIndex(this.t.source, "name");
      for await (const r of this.file.scan(this.t.source)) sources.set(Number(r.rowid), String(r.values[nameAt]));
    }
    const c = (name: string) => colIndex(this.t.book, name);
    const [title, sourceId, categoryId, orderIndex, isBase, total, dependence] = ["title", "sourceId", "categoryId", "orderIndex", "isBaseBook", "totalLines", "dependenceType"].map(c);
    const out: DbBook[] = [];
    for await (const r of this.file.scan(this.t.book)) {
      const v = r.values;
      const at = (i: number | undefined) => (i === undefined || i < 0 ? null : v[i] ?? null);
      out.push({
        id: Number(r.rowid),
        title: String(at(title) ?? ""),
        source: at(sourceId) === null ? null : sources.get(Number(at(sourceId))) ?? null,
        categoryId: num(at(categoryId)),
        orderIndex: num(at(orderIndex)),
        isBaseBook: at(isBase) === null ? null : Number(at(isBase)) === 1,
        totalLines: num(at(total)),
        dependenceType: at(dependence) === null ? null : String(at(dependence)),
      });
    }
    return out;
  }

  /** book_has_links: the books with hasSourceLinks = 1. Empty when the table is absent. */
  async booksWithSourceLinks(): Promise<Set<number>> {
    const out = new Set<number>();
    const t = await this.file.table("book_has_links");
    if (!t) return out;
    const [b, has] = [colIndex(t, "bookId"), colIndex(t, "hasSourceLinks")];
    if (has < 0) return out;
    for await (const r of this.file.scan(t)) if (Number(r.values[has]) === 1) out.add(b < 0 ? Number(r.rowid) : Number(r.values[b] ?? r.rowid));
    return out;
  }

  /**
   * book_base_text (schema 2+): bookId → the base books it is written on, as Sefaria declares them.
   * A small table (5.4K rows in the full library), scanned once. Empty when the table is absent.
   */
  async baseTexts(): Promise<Map<number, number[]>> {
    const out = new Map<number, number[]>();
    const t = await this.file.table("book_base_text");
    if (!t) return out;
    const [b, base] = [colIndex(t, "bookId"), colIndex(t, "baseBookId")];
    if (b < 0 || base < 0) return out;
    for await (const r of this.file.scan(t)) {
      const id = Number(r.values[b]);
      pushTo(out, id, Number(r.values[base]));
    }
    return out;
  }

  /**
   * default_commentator (schema 3+): commentatorBookId → the books it is a default commentator of
   * (the app opens it beside them). 723 rows in the full library, scanned once; empty when absent.
   * It pairs commentaries that book_base_text and the title do not ("בית יוסף" on "טור").
   */
  async defaultCommentators(): Promise<Map<number, number[]>> {
    const out = new Map<number, number[]>();
    const t = await this.file.table("default_commentator");
    if (!t) return out;
    const [b, c] = [colIndex(t, "bookId"), colIndex(t, "commentatorBookId")];
    if (b < 0 || c < 0) return out;
    for await (const r of this.file.scan(t)) pushTo(out, Number(r.values[c]), Number(r.values[b]));
    return out;
  }

  /** (lineIndex, lineId) of every line of a book, in order — from the (bookId, lineIndex) index when present. */
  async lineEntries(bookId: number): Promise<{ index: number; id: number }[]> {
    const ix = await this.file.findIndex("line", ["bookId", "lineIndex"]);
    const out: { index: number; id: number }[] = [];
    if (ix) {
      for await (const rec of this.file.seekIndex(ix, [bookId])) out.push({ index: Number(rec[1]), id: Number(rec[rec.length - 1]) });
      return out;
    }
    // no index (some personal databases): full scan of line, sorted in memory
    const b = colIndex(this.t.line, "bookId");
    const li = colIndex(this.t.line, "lineIndex");
    for await (const r of this.file.scan(this.t.line)) if (Number(r.values[b]) === bookId) out.push({ index: Number(r.values[li]), id: Number(r.rowid) });
    return out.sort((a, b2) => a.index - b2.index);
  }

  /** Lines [from, to] (inclusive, 0-based lineIndex) of a book. */
  async lines(bookId: number, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<DbLine[]> {
    return this.linesAt((await this.lineEntries(bookId)).filter((e) => e.index >= from && e.index <= to));
  }

  /**
   * The whole book in chunks of `size` lines, walking the line index ONCE (lines() walks it on every
   * call). For a scan of a whole book (in-book search) without holding all of it in memory.
   */
  async *lineChunks(bookId: number, size: number): AsyncGenerator<{ lines: DbLine[]; total: number }> {
    const entries = await this.lineEntries(bookId);
    for (let i = 0; i < entries.length; i += size) yield { lines: await this.linesAt(entries.slice(i, i + size)), total: entries.length };
  }

  private async linesAt(entries: readonly { index: number; id: number }[]): Promise<DbLine[]> {
    const ids = entries.map((e) => e.id);
    const lineRows = await this.file.getMany(this.t.line, ids);
    const contentRows = this.t.content ? await this.file.getMany(this.t.content, ids) : null;
    const heRefAt = colIndex(this.t.line, "heRef");
    const contentAt = this.caps.text === "line.content" ? colIndex(this.t.line, "content") : contentRows ? colIndex(this.t.content!, "content") : -1;
    const notes = this.t.note ? await this.notesOf(ids) : new Map<number, NoteAt[]>();
    return entries.map((e) => {
      const row = lineRows.get(e.id);
      const raw = contentRows ? contentRows.get(e.id)?.values[contentAt] : row?.values[contentAt];
      return {
        index: e.index,
        lineId: e.id,
        heRef: heRefAt >= 0 ? ((row?.values[heRefAt] as string | null) ?? null) : null,
        content: this.codec.decode(raw ?? null) ?? "",
        notes: notes.get(e.id) ?? [],
      };
    });
  }

  /**
   * (lineIndex, heRef) of every line of a book, WITHOUT the text (no decompression): the
   * citations engine's reference index of a cited book. Empty when the database has no heRef column.
   */
  async heRefs(bookId: number): Promise<{ index: number; heRef: string | null }[]> {
    const heRefAt = colIndex(this.t.line, "heRef");
    const entries = await this.lineEntries(bookId);
    if (heRefAt < 0) return entries.map((e) => ({ index: e.index, heRef: null }));
    const rows = await this.file.getMany(this.t.line, entries.map((e) => e.id));
    return entries.map((e) => ({ index: e.index, heRef: (rows.get(e.id)?.values[heRefAt] as string | null | undefined) ?? null }));
  }

  /** Other names of books (book_acronym: bookId → terms), or an empty map when the table is absent. */
  async acronyms(): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    const t = await this.file.table("book_acronym");
    if (!t) return out;
    const [b, term] = [colIndex(t, "bookId"), colIndex(t, "term")];
    if (b < 0 || term < 0) return out;
    for await (const r of this.file.scan(t)) {
      const id = Number(r.values[b]);
      const v = r.values[term];
      if (typeof v !== "string" || !v.trim()) continue;
      const list = out.get(id);
      if (list) list.push(v);
      else out.set(id, [v]);
    }
    return out;
  }

  /**
   * The text link_anchor offsets of this line count: the stored line with its schema-7 footnote
   * bodies put back (LineNoteRehydration). For older schemas it is the stored line.
   */
  anchorText(line: DbLine): string {
    return rehydrateLine(line.content, line.notes);
  }

  private async notesOf(lineIds: number[]): Promise<Map<number, NoteAt[]>> {
    const t = this.t.note!;
    const [charPos, hasMarker, body] = ["charPos", "hasMarker", "body"].map((n) => colIndex(t, n));
    const lineIdAt = colIndex(t, "lineId");
    const out = new Map<number, NoteAt[]>();
    // one ordered walk for all lines; rows come in (lineId, noteIndex) order
    for (const r of await this.file.seekPrimaryKeyMany(t, lineIds.map((id) => [id]))) {
      const id = Number(r.values[lineIdAt]);
      const list = out.get(id) ?? [];
      list.push({
        charPos: Number(r.values[charPos!]),
        hasMarker: Number(r.values[hasMarker!]) === 1,
        body: this.codec.decode(r.values[body!] ?? null) ?? "",
      });
      out.set(id, list);
    }
    return out;
  }
}

function colIndex(t: TableInfo, name: string): number {
  return t.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
}

function num(v: SqlValue | null): number | null {
  return v === null ? null : Number(v);
}
