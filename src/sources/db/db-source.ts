import { canonicalTypeString } from "../../core/links/connection-type";
import type { BookOrigin, BookRef, Link } from "../../core/links/model";
import { headingLevel } from "../../core/text/html";
import type { LibraryAltTocStructure } from "../../core/alt-toc/model";
import { readAltToc } from "../../database/otzaria/alt-toc-reader";
import { DbLinksReader, type DbLinkRow } from "../../database/otzaria/links-reader";
import { OtzariaDbReader, type DbBook, type DbLine } from "../../database/otzaria/reader";
import type { ByteSource } from "../../database/sqlite/lazy/byte-source";
import type { BookSource, LineChunk, SourceBook, SourceInfo, SourceLine } from "../book-source";

/*
 * An Otzaria-family database as a book source. Read-only by construction: nothing here can write.
 * Existing links come back in the STORED direction with provenance "db" — they are shown, checked
 * and compared, but never re-exported as if a links file had said them (LINK_FORMATS §4.4).
 */
export class DbBookSource implements BookSource {
  private booksById = new Map<number, DbBook>();

  private constructor(
    readonly info: SourceInfo,
    private readonly reader: OtzariaDbReader,
    private readonly links: DbLinksReader | null,
  ) {}

  static async open(id: string, label: string, src: ByteSource): Promise<DbBookSource> {
    const reader = await OtzariaDbReader.open(src);
    const links = await DbLinksReader.open(reader.file, reader.caps);
    const warnings = [...reader.caps.warnings];
    if (links && !links.indexed)
      warnings.push({ code: "db/links-unindexed", message: "לטבלת הקישורים במסד אין אינדקס לפי שורה, ולכן הצגת קישורים קיימים תהיה איטית במסד גדול." });
    const s = new DbBookSource({ id, kind: "otzaria-db", label, warnings }, reader, links);
    for (const b of await reader.books()) s.booksById.set(b.id, b);
    return s;
  }

  get capabilities() {
    return this.reader.caps;
  }

  async books(): Promise<SourceBook[]> {
    return [...this.booksById.values()].map((b) => ({
      key: this.keyOf(b.id),
      title: b.title,
      origin: this.originOf(b),
      ...(b.isBaseBook !== null && { isBaseBook: b.isBaseBook }),
      ...(b.totalLines !== null && { lineCount: b.totalLines }),
      ...(b.source !== null && { sourceName: b.source }),
    }));
  }

  async lines(bookKey: string, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<SourceLine[]> {
    return this.toLines(await this.reader.lines(this.idOf(bookKey), from, to));
  }

  async *scan(bookKey: string, chunk: number): AsyncGenerator<LineChunk> {
    for await (const c of this.reader.lineChunks(this.idOf(bookKey), chunk)) yield { lines: this.toLines(c.lines), total: c.total };
  }

  private toLines(rows: DbLine[]): SourceLine[] {
    return rows.map((l) => ({
      index: l.index,
      text: l.content,
      anchorText: this.reader.anchorText(l),
      heRef: l.heRef,
      heading: headingLevel(l.content),
      existsInDb: true,
    }));
  }

  async existingLinks(bookKey: string, from: number, to: number): Promise<Link[]> {
    if (!this.links) return [];
    const lines = await this.reader.lineEntries(this.idOf(bookKey));
    const ids = lines.filter((e) => e.index >= from && e.index <= to).map((e) => e.id);
    return (await this.links.atLines(ids)).map((r) => this.toLink(r));
  }

  async altToc(bookKey: string): Promise<LibraryAltTocStructure[] | null> {
    if (!this.reader.caps.altToc) return null;
    const index = new Map((await this.reader.lineEntries(this.idOf(bookKey))).map((e) => [e.id, e.index]));
    return readAltToc(this.reader.file, this.idOf(bookKey), (id) => index.get(id));
  }

  close(): void {
    this.booksById.clear();
  }

  private toLink(r: DbLinkRow): Link {
    const ref = (bookId: number): BookRef => {
      const b = this.booksById.get(bookId);
      return {
        key: this.keyOf(bookId),
        title: b?.title ?? `#${bookId}`,
        origin: b ? this.originOf(b) : "unknown",
        ...(b && b.isBaseBook !== null && { isBaseBook: b.isBaseBook }),
      };
    };
    const end = (e: DbLinkRow["source"]) => ({ book: ref(e.bookId), line: e.lineIndex, ...(e.endIndex !== undefined && e.endIndex > e.lineIndex && { end: e.endIndex }) });
    return {
      id: `${this.info.id}:link:${r.id}`,
      status: "existing",
      provenance: "db",
      source: end(r.source),
      target: end(r.target),
      declaredType: canonicalTypeString(r.type),
      heRef2: r.target.heRef ?? `${ref(r.target.bookId).title} ${r.target.lineIndex + 1}`,
      ...(r.anchors.length > 0 && { dbAnchors: r.anchors }),
    };
  }

  private originOf(b: DbBook): BookOrigin {
    if (this.reader.caps.kind !== "official") return "personal";
    return b.source && /sefaria/i.test(b.source) ? "sefaria" : "otzaria";
  }

  private keyOf(bookId: number): string {
    return `${this.info.id}:${bookId}`;
  }

  private idOf(bookKey: string): number {
    return Number(bookKey.slice(this.info.id.length + 1));
  }
}

