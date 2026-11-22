import { CONNECTION_TYPES, canonicalTypeString } from "../../core/links/connection-type";
import type { BookOrigin, BookRef, Link } from "../../core/links/model";
import { headingLevel } from "../../core/text/html";
import type { LibraryAltTocStructure } from "../../core/alt-toc/model";
import { readAltToc } from "../../database/otzaria/alt-toc-reader";
import { ExternalLinksReader, type ExternalLinkRow, type InternalLinks } from "../../database/otzaria/external-links-reader";
import { DbLinksReader, type DbLinkRow } from "../../database/otzaria/links-reader";
import { OtzariaDbReader, type DbBook, type DbLine } from "../../database/otzaria/reader";
import type { ByteSource } from "../../database/sqlite/lazy/byte-source";
import type { BookSource, LineChunk, SourceBook, SourceInfo, SourceLine } from "../book-source";
import type { ExternalTargetResolver } from "./external-target";
import { LinkListing } from "./link-listing";

/*
 * An Otzaria-family database as a book source. Read-only by construction: nothing here can write.
 * Existing links come back in the STORED direction with provenance "db" — they are shown, checked
 * and compared, but never re-exported as if a links file had said them (LINK_FORMATS §4.4).
 */
export class DbBookSource implements BookSource {
  private booksById = new Map<number, DbBook>();
  /** listings of the last few books shown in the links panel (a big base book holds ~235k links) */
  private readonly listings = new Map<number, Promise<LinkListing>>();
  /** book_base_text, read once at open */
  private bases = new Map<number, number[]>();
  /** default_commentator, commentary → the books it is a default commentator of; read once at open */
  private commentatorOf = new Map<number, number[]>();
  /** book_has_links.hasSourceLinks, read once at open */
  private withLinks = new Set<number>();

  private constructor(
    readonly info: SourceInfo,
    private readonly reader: OtzariaDbReader,
    private readonly links: DbLinksReader | null,
    /** the links of a database that has no `link` table: its `external_link` (Personal-DB-Creator) */
    private readonly ext: ExternalLinksReader | null = null,
  ) {}

  /** where an external_link row's target lives (other sources): set by the registry, absent in a lone source */
  private resolver: ExternalTargetResolver | null = null;
  /** the links between books of this database, from one scan of external_link (built on demand, cached) */
  private internalLinks: Promise<InternalLinks> | null = null;
  private titleToId: Map<string, number> | null = null;

  static async open(id: string, label: string, src: ByteSource): Promise<DbBookSource> {
    const reader = await OtzariaDbReader.open(src);
    const links = await DbLinksReader.open(reader.file, reader.caps);
    // a database with both tables keeps using `link`; external_link is for the ones without it (#13)
    const ext = links ? null : await ExternalLinksReader.open(reader.file, reader.caps);
    const warnings = [...reader.caps.warnings];
    if (ext && !ext.indexed)
      warnings.push({ code: "db/external-links-unindexed", message: "לטבלת הקישורים החיצוניים (external_link) במסד אין אינדקס לפי ספר, ולכן הצגת הקישורים של ספר תסרוק את כל הטבלה: איטי במסד גדול." });
    if (links && !links.indexed)
      warnings.push({ code: "db/links-unindexed", message: "לטבלת הקישורים במסד אין אינדקס לפי שורה, ולכן הצגת קישורים קיימים תהיה איטית במסד גדול." });
    const s = new DbBookSource({ id, kind: "otzaria-db", label, warnings }, reader, links, ext);
    for (const b of await reader.books()) s.booksById.set(b.id, b);
    s.info.library = isLibraryDb(reader.caps.kind, label, s.booksById.values());
    s.bases = await reader.baseTexts();
    s.commentatorOf = await reader.defaultCommentators();
    s.withLinks = await reader.booksWithSourceLinks();
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
      ...(this.bases.has(b.id) && { bases: this.bases.get(b.id)!.map((id) => this.keyOf(id)) }),
      ...(b.dependenceType !== null && { dependence: b.dependenceType }),
      ...(this.commentatorOf.has(b.id) && { linkedBases: this.commentatorOf.get(b.id)!.filter((id) => this.booksById.has(id)).map((id) => this.keyOf(id)) }),
      ...(this.withLinks.has(b.id) && { hasSourceLinks: true }),
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
    if (this.ext) return this.externalLinksAt(this.idOf(bookKey), from, to);
    if (!this.links) return [];
    const lines = await this.reader.lineEntries(this.idOf(bookKey));
    const ids = lines.filter((e) => e.index >= from && e.index <= to).map((e) => e.id);
    return (await this.links.atLines(ids)).map((r) => this.toLink(r));
  }

  /**
   * Every link of a book, from the link table's book indexes (DbLinksReader.bookLinks). The line
   * index of the book's own end comes from the (bookId, lineIndex) index; the other end is read
   * only for the page shown.
   */
  async linkListing(bookKey: string, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}): Promise<LinkListing | string> {
    if (!this.links && !this.ext) return `במסד "${this.info.label}" אין טבלת קישורים (link) ואין בו קישורים חיצוניים (external_link). ייתכן שזו גרסה ישנה או מסד אישי בלי קישורים.`;
    const id = this.idOf(bookKey);
    let p = this.listings.get(id);
    if (!p) {
      p = this.ext ? this.buildExternalListing(bookKey, id, ctx) : this.buildListing(bookKey, id, ctx);
      this.listings.set(id, p);
      p.catch(() => this.listings.delete(id)); // a cancelled or failed read is not cached
      while (this.listings.size > 3) this.listings.delete(this.listings.keys().next().value!);
    }
    return p;
  }

  private async buildListing(bookKey: string, id: number, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void }): Promise<LinkListing> {
    const t0 = performance.now();
    const rows = await this.links!.bookLinks(id, ctx);
    const own = new Map((await this.reader.lineEntries(id)).map((e) => [e.id, e.index]));
    const others = [...new Set(rows.other)];
    const otherAt = new Map(others.map((b, i) => [b, i]));
    const n = rows.ids.length;
    const ownIndex = new Int32Array(n);
    const other = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      ownIndex[i] = own.get(rows.ownLine[i]!) ?? -1;
      other[i] = otherAt.get(rows.other[i]!)!;
    }
    return new LinkListing(
      bookKey,
      { ref: rows.ids, dir: rows.dir, other, type: rows.type, ownIndex },
      others.map((b) => this.keyOf(b)),
      async (ids) => {
        const got = new Map((await this.links!.byIds(ids)).map((r) => [r.id, this.toLink(r)]));
        return ids.map((i) => got.get(i)).filter((l): l is Link => !!l);
      },
      rows.method,
      Math.round(performance.now() - t0),
    );
  }

  /* ---------------- external_link (a personal database without a link table, #13) ---------------- */

  setTargetResolver(r: ExternalTargetResolver): void {
    this.resolver = r;
  }

  /** The open sources changed (a library opened or closed): what the listings resolved may be stale. */
  targetsChanged(): void {
    if (this.ext) this.listings.clear();
  }

  private get libraryId(): string | undefined {
    return this.reader.caps.meta["library_id"];
  }

  private titles(): Map<string, number> {
    return (this.titleToId ??= new Map([...this.booksById.values()].map((b) => [b.title, b.id])));
  }

  private internal(ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}): Promise<InternalLinks> {
    if (!this.internalLinks) {
      this.internalLinks = this.ext!.internal(this.libraryId, this.titles(), ctx);
      this.internalLinks.catch(() => (this.internalLinks = null)); // a cancelled or failed scan is not cached
    }
    return this.internalLinks;
  }

  /** the target book of a row: this database's own, or the one the registry finds in another source; null when none is open */
  private async targetBook(r: Pick<ExternalLinkRow, "targetSource" | "targetTitle">): Promise<BookRef | null> {
    const own = this.titles().get(r.targetTitle);
    if (own !== undefined && (r.targetSource === this.libraryId || (r.targetSource === null && !(await this.resolver?.book(r.targetTitle, null, this.info.id))))) return this.bookRef(own);
    return (await this.resolver?.book(r.targetTitle, r.targetSource, this.info.id)) ?? null;
  }

  private bookRef(bookId: number): BookRef {
    const b = this.booksById.get(bookId);
    return {
      key: this.keyOf(bookId),
      title: b?.title ?? `#${bookId}`,
      origin: b ? this.originOf(b) : "unknown",
      ...(b && b.isBaseBook !== null && { isBaseBook: b.isBaseBook }),
    };
  }

  private async externalLinksAt(bookId: number, from: number, to: number): Promise<Link[]> {
    const rows = await this.ext!.atLines(bookId, from, to);
    const out = await Promise.all(rows.map((r) => this.externalToLink(r)));
    // links INTO these lines from this database's own books — only once the scan that finds them has been made
    // (the listing builds it; a click on a line must not wait for a scan of the whole table)
    if (this.internalLinks) {
      const ix = await this.internalLinks;
      const at = ix.range.get(bookId);
      if (at) {
        const ids: number[] = [];
        for (let i = at[0]; i < at[1]; i++) if (ix.targetLine[i]! >= from && ix.targetLine[i]! <= to && ix.sourceBook[i] !== bookId) ids.push(ix.rowid[i]!);
        out.push(...(await Promise.all((await this.ext!.byRowids(ids)).map((r) => this.externalToLink(r)))));
      }
    }
    return out;
  }

  /**
   * A book's links from external_link: the outgoing rows from idx_external_link_source and, from the one
   * table scan, the links into it from this database's own books. Compact rows only; a page resolves its own
   * targets (the registry, by title and heRef) when it is shown.
   */
  private async buildExternalListing(bookKey: string, id: number, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void }): Promise<LinkListing> {
    const t0 = performance.now();
    const rows = await this.ext!.outgoing(id, ctx);
    const ix = await this.internal(ctx);
    const incoming: number[] = [];
    const at = ix.range.get(id);
    if (at) for (let i = at[0]; i < at[1]; i++) if (ix.sourceBook[i] !== id) incoming.push(i);
    const n = rows.length + incoming.length;
    const keys: string[] = [];
    const keyAt = new Map<string, number>();
    const slot = (key: string) => keyAt.get(key) ?? (keyAt.set(key, keys.length), keys.push(key) - 1);
    const lis = { ref: new Float64Array(n), dir: new Uint8Array(n), other: new Int32Array(n), type: new Uint8Array(n), ownIndex: new Int32Array(n) };
    const targets = new Map<string, string>(); // (source, title) → the key of the book it names
    let k = 0;
    for (const r of rows) {
      const memo = `${r.targetSource ?? ""}\u0000${r.targetTitle}`;
      let key = targets.get(memo);
      if (key === undefined) {
        key = (await this.targetBook(r))?.key ?? `unresolved:${r.targetTitle}`;
        targets.set(memo, key);
      }
      lis.ref[k] = r.rowid;
      lis.dir[k] = 0;
      lis.other[k] = slot(key);
      lis.type[k] = CONNECTION_TYPES.indexOf(this.ext!.typeOf(r.typeName));
      lis.ownIndex[k] = r.lineIndex;
      k++;
    }
    for (const i of incoming) {
      lis.ref[k] = ix.rowid[i]!;
      lis.dir[k] = 1;
      lis.other[k] = slot(this.keyOf(ix.sourceBook[i]!));
      lis.type[k] = ix.type[i]!;
      lis.ownIndex[k] = ix.targetLine[i]!;
      k++;
    }
    return new LinkListing(
      bookKey,
      lis,
      keys,
      async (ids) => {
        const got = new Map<number, Link>();
        for (const r of await this.ext!.byRowids(ids)) got.set(r.rowid, await this.externalToLink(r));
        return ids.map((i) => got.get(i)).filter((l): l is Link => !!l);
      },
      this.ext!.indexed ? "index" : "scan",
      Math.round(performance.now() - t0),
    );
  }

  /**
   * One external_link row as a link in its STORED direction (own book → target). The target line is the heRef's
   * line in the target book when the row has a ref and the book is open (the library renumbers lines between
   * versions, a ref survives), else targetLineIndex. A target that is in no open source keeps its title (it is
   * bound when that source opens) and the ref as its place name; nothing is guessed.
   */
  private async externalToLink(r: ExternalLinkRow): Promise<Link> {
    const book = await this.targetBook(r);
    let line = r.targetLine ?? 0;
    if (book && r.targetRef?.trim() && !book.key.startsWith(`${this.info.id}:`)) line = (await this.resolver?.lineOfRef(book.key, r.targetRef)) ?? line;
    const target: BookRef = book ?? { key: `unresolved:${r.targetTitle}`, title: r.targetTitle, origin: "unknown" };
    return {
      id: `${this.info.id}:ext:${r.rowid}`,
      status: "existing",
      provenance: "db",
      source: { book: this.bookRef(r.bookId), line: r.lineIndex },
      target: { book: target, line },
      declaredType: canonicalTypeString(this.ext!.typeOf(r.typeName)),
      heRef2: r.targetRef?.trim() ? r.targetRef : `${target.title} ${line + 1}`,
    };
  }

  async altToc(bookKey: string): Promise<LibraryAltTocStructure[] | null> {
    if (!this.reader.caps.altToc) return null;
    const index = new Map((await this.reader.lineEntries(this.idOf(bookKey))).map((e) => [e.id, e.index]));
    return readAltToc(this.reader.file, this.idOf(bookKey), (id) => index.get(id));
  }

  /** book_acronym, read once per open database (42K rows in the official one) */
  private aliases: Promise<ReadonlyMap<string, readonly string[]>> | null = null;

  bookAliases(): Promise<ReadonlyMap<string, readonly string[]>> {
    this.aliases ??= this.reader.acronyms().then((m) => {
      const out = new Map<string, readonly string[]>();
      for (const [id, terms] of m) if (this.booksById.has(id)) out.set(this.keyOf(id), terms);
      return out;
    });
    return this.aliases;
  }

  async heRefs(bookKey: string): Promise<{ index: number; heRef: string | null }[]> {
    return this.reader.heRefs(this.idOf(bookKey));
  }

  close(): void {
    this.booksById.clear();
    this.listings.clear();
    this.internalLinks = null;
    this.titleToId = null;
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
      heRef2: r.target.heRef?.trim() ? r.target.heRef : `${ref(r.target.bookId).title} ${r.target.lineIndex + 1}`,
      ...(r.anchors.length > 0 && { dbAnchors: r.anchors }),
      ...(r.suppressedSides.length > 0 && { dbSuppressed: [...r.suppressedSides].sort() }),
    };
  }

  private originOf(b: DbBook): BookOrigin {
    if (!this.info.library) return "personal";
    return b.source && /sefaria/i.test(b.source) ? "sefaria" : "otzaria";
  }

  private keyOf(bookId: number): string {
    return `${this.info.id}:${bookId}`;
  }

  private idOf(bookKey: string): number {
    return Number(bookKey.slice(this.info.id.length + 1));
  }
}

/**
 * Whether a database is the official Otzaria library (product audit F12). The layout cannot tell: a
 * personal database built in the Otzaria schema has the same tables, and without a personal marker
 * (user_link, book.isPersonal, library_id — capabilities.ts) it looks "official". The library's own
 * database is built from Sefaria first (Generator.kt: Sefaria is the priority source), so it always
 * holds books whose source is Sefaria; one without any is the user's. A file named seforim.db — the
 * library's name — counts too, for old schemas without a source table.
 */
export function isLibraryDb(kind: string, label: string, books: Iterable<Pick<DbBook, "source">>): boolean {
  if (kind !== "official") return false;
  if (/^seforim\.db$/i.test(label)) return true;
  for (const b of books) if (b.source && /sefaria/i.test(b.source)) return true;
  return false;
}
