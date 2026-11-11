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
    if (!book || !line) throw new LinkerError("db/no-books", "במסד אין טבלאות ספרים ושורות במבנה של אוצריא. פתחו אותו בגרירה לחלון או מכפתור הקבצים: הכלי יציג את הטבלאות שלו ויבקש לבחור איפה הספרים ואיפה השורות.");
    const dicts: Uint8Array[] = [];
    if (caps.compressed) {
      for await (const r of file.scan((await file.table("zstd_dict"))!)) {
        const d = r.values[1];
        if (d instanceof Uint8Array) dicts.push(d);
      }
    }
    return new OtzariaDbReader(file, caps, new LineContentCodec(dicts), {
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
    const [title, sourceId, categoryId, orderIndex, isBase, total] = ["title", "sourceId", "categoryId", "orderIndex", "isBaseBook", "totalLines"].map(c);
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
      });
    }
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
    const entries = (await this.lineEntries(bookId)).filter((e) => e.index >= from && e.index <= to);
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
