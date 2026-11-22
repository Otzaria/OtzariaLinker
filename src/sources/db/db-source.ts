import { MAX_BOOK_LINES } from "../../core/limits";
import { CONNECTION_TYPES, canonicalTypeString } from "../../core/links/connection-type";
import { DB_LINK_FLAGS, type BookOrigin, type BookRef, type DbLinkFlag, type Link } from "../../core/links/model";
import { headingLevel } from "../../core/text/html";
import type { LibraryAltTocStructure } from "../../core/alt-toc/model";
import { readAltToc } from "../../database/otzaria/alt-toc-reader";
import { ExternalLinksReader, type ExternalLinkRow, type InternalLinks } from "../../database/otzaria/external-links-reader";
import { DbLinksReader, type DbLinkRow } from "../../database/otzaria/links-reader";
import { OtzariaDbReader, type DbBook, type DbLine } from "../../database/otzaria/reader";
import { TocLines } from "../../database/otzaria/toc-lines";
import type { ByteSource } from "../../database/sqlite/lazy/byte-source";
import type { BookSource, LineChunk, SourceBook, SourceInfo, SourceLine } from "../book-source";
import type { ExternalTargetResolver } from "./external-target";
import { LinkListing, type ListingRows } from "./link-listing";

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
    // a database with both tables lists the links of both, each once (mergeParts); external_link alone is a personal database (#13)
    const ext = await ExternalLinksReader.open(reader.file, reader.caps);
    const warnings = [...reader.caps.warnings];
    if (ext && !ext.indexed)
      warnings.push({ code: "db/external-links-unindexed", message: "לטבלת הקישורים החיצוניים (external_link) במסד אין אינדקס לפי ספר, ולכן הצגת הקישורים של ספר תסרוק את כל הטבלה: איטי במסד גדול. כדי להאיץ, צרו במסד אינדקס על (sourceBookId, sourceLineIndex) בכלי שיצר אותו." });
    if (links && !links.indexed)
      warnings.push({ code: "db/links-unindexed", message: "לטבלת הקישורים במסד אין אינדקס לפי שורה, ולכן הצגת קישורים קיימים תהיה איטית במסד גדול." });
    const s = new DbBookSource({ id, kind: "otzaria-db", label, warnings }, reader, links, ext);
    for (const b of await reader.books()) s.booksById.set(b.id, b);
    const badTotals = [...s.booksById.values()].filter((b) => b.declaredTotalInvalid !== undefined);
    if (badTotals.length)
      warnings.push({
        code: "db/book-line-count-invalid",
        message: `ב־${badTotals.length} ספרים במסד מספר השורות המוצהר (totalLines) אינו מספר שורות אפשרי (שלילי, שבר, או מעל ${MAX_BOOK_LINES.toLocaleString("he")}), ולכן הוא לא נלקח בחשבון: ${badTotals.slice(0, 3).map((b) => `"${b.title}" (${b.declaredTotalInvalid})`).join(", ")}${badTotals.length > 3 ? "…" : ""}. אורך הספר ייקבע מהשורות עצמן.`,
      });
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
    const fromExt = this.ext ? await this.externalLinksAt(this.idOf(bookKey), from, to) : [];
    if (!this.links) return fromExt;
    const lines = await this.reader.lineEntries(this.idOf(bookKey));
    const ids = lines.filter((e) => e.index >= from && e.index <= to).map((e) => e.id);
    const fromLink = (await this.links.atLines(ids)).map((r) => this.toLink(r));
    return fromExt.length ? [...fromLink, ...fromExt.filter((e) => !fromLink.some((l) => sameLink(l, e)))] : fromLink;
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
      p = this.buildAnyListing(bookKey, id, ctx);
      this.listings.set(id, p);
      p.catch(() => this.listings.delete(id)); // a cancelled or failed read is not cached
      while (this.listings.size > 3) this.listings.delete(this.listings.keys().next().value!);
    }
    return p;
  }

  /**
   * The listing of a book: from the `link` table, from `external_link`, or — a database that has BOTH — from the two
   * together, each link once (an external_link row that repeats a `link` row of the same own line, other book, other
   * line and type is dropped) and each keeping its own id and provenance "db".
   */
  private async buildAnyListing(bookKey: string, id: number, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void }): Promise<LinkListing> {
    const t0 = performance.now();
    const parts: ListingPart[] = [];
    if (this.links) parts.push(await this.buildListing(id, ctx));
    if (this.ext) parts.push(await this.buildExternalListing(id, ctx));
    return mergeParts(bookKey, parts, Math.round(performance.now() - t0));
  }

  private async buildListing(id: number, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void }): Promise<ListingPart> {
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
    return {
      rows: { ref: rows.ids, dir: rows.dir, other, type: rows.type, ownIndex },
      otherLine: rows.otherLine,
      keys: others.map((b) => this.keyOf(b)),
      fetch: async (ids) => {
        const got = new Map((await this.links!.byIds(ids)).map((r) => [r.id, this.toLink(r)]));
        return ids.map((i) => got.get(i)).filter((l): l is Link => !!l);
      },
      method: rows.method,
    };
  }

  /* ---------------- external_link (a personal database without a link table, #13) ---------------- */

  setTargetResolver(r: ExternalTargetResolver): void {
    this.resolver = r;
  }

  /** The open sources changed (a library opened or closed): what the listings resolved may be stale. */
  targetsChanged(): void {
    if (this.ext) {
      this.listings.clear();
      this.targets.clear();
      this.libraryTitles.clear();
    }
  }

  private get libraryId(): string | undefined {
    return this.reader.caps.meta["library_id"];
  }

  private titles(): Map<string, number> {
    // two books of one title: the first (lowest id, the order of the book table) wins — the same rule as the registry's title index
    if (!this.titleToId) {
      this.titleToId = new Map();
      for (const b of this.booksById.values()) if (!this.titleToId.has(b.title)) this.titleToId.set(b.title, b.id);
    }
    return this.titleToId;
  }

  private internal(ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}): Promise<InternalLinks> {
    if (!this.internalLinks) {
      this.internalLinks = this.ext!.internal(this.libraryId, this.titles(), ctx);
      this.internalLinks.catch(() => (this.internalLinks = null)); // a cancelled or failed scan is not cached
    }
    return this.internalLinks;
  }

  /** (source, title) → what the row's target is: memoized; cleared when the open sources change */
  private targets = new Map<string, Promise<ResolvedTarget>>();
  private libraryTitles = new Map<string, Promise<boolean>>();
  private toc: Promise<TocLines | null> | null = null;

  /**
   * The target of a row: this database's own book, or the one the registry finds in another source (by the row's
   * targetSource and the exact title); `book` is null when none is open — the link keeps the title alone.
   */
  private resolveTarget(r: Pick<ExternalLinkRow, "targetSource" | "targetTitle">): Promise<ResolvedTarget> {
    const memo = `${r.targetSource ?? ""}\u0000${r.targetTitle}`;
    let p = this.targets.get(memo);
    if (!p) {
      p = (async (): Promise<ResolvedTarget> => {
        const own = this.titles().get(r.targetTitle);
        if (own !== undefined && (r.targetSource === this.libraryId || (r.targetSource === null && !(await this.resolver?.book(r.targetTitle, null, this.info.id)))))
          return { book: this.bookRef(own), own: true, bookId: own, ...(this.booksById.get(own)?.totalLines != null && { lineCount: this.booksById.get(own)!.totalLines! }) };
        const t = await this.resolver?.book(r.targetTitle, r.targetSource, this.info.id);
        return t ? { book: { key: t.key, title: t.title, origin: t.origin, ...(t.isBaseBook !== undefined && { isBaseBook: t.isBaseBook }) }, own: false, ...(t.lineCount !== undefined && { lineCount: t.lineCount }) } : { book: null, own: false };
      })();
      this.targets.set(memo, p);
    }
    return p;
  }

  private async targetBook(r: Pick<ExternalLinkRow, "targetSource" | "targetTitle">): Promise<BookRef | null> {
    return (await this.resolveTarget(r)).book;
  }

  /** whether the open library has a book of this title (an own book of the same title is then ambiguous) */
  private libraryHas(title: string): Promise<boolean> {
    let p = this.libraryTitles.get(title);
    if (!p) {
      p = (async () => !!(await this.resolver?.book(title, "official", this.info.id)))();
      this.libraryTitles.set(title, p);
    }
    return p;
  }

  private tocLines(): Promise<TocLines | null> {
    return (this.toc ??= TocLines.read(this.reader.file, this.reader.caps).catch(() => null));
  }

  /**
   * The flags of a row (DbLinkFlag): from the row and the books alone, so the summary's count and the page's links
   * agree. A heading is a line with a table-of-contents entry (TocLines: a close proxy). A target line past the end of
   * the book is flagged only when the line is known without the heRef (the own book, or no ref) and the book's length
   * is: the library's book must be open. Reverse duplicates are internal rows (InternalLinks.reverse).
   */
  private async flagsOf(r: ExternalLinkRow, ix: InternalLinks | null, toc: TocLines | null): Promise<number> {
    const t = await this.resolveTarget(r);
    const bit = (f: DbLinkFlag) => 1 << DB_LINK_FLAGS.indexOf(f);
    let f = 0;
    if (r.targetLine !== null && t.lineCount !== undefined && (t.own || !r.targetRef?.trim()) && r.targetLine >= t.lineCount) f |= bit("target-out-of-range");
    if (toc && toc.has(r.bookId, r.lineIndex)) f |= bit("header-source");
    if (t.own) {
      if (toc && t.bookId !== undefined && r.targetLine !== null && toc.has(t.bookId, r.targetLine)) f |= bit("header-target");
      if (ix) {
        const at = ix.positionOf(r.rowid);
        if (at >= 0 && ix.reverse[at]) f |= bit("reverse-duplicate");
      }
      if (await this.libraryHas(r.targetTitle)) f |= bit("ambiguous-title");
    }
    return f;
  }

  /**
   * Whether the internal row at `i` really points at this database's book. A row with no targetSource means "any
   * source, the library first": it reaches this database only when the library does not have the title.
   */
  private async reachesOwn(ix: InternalLinks, i: number, memo: Map<number, boolean>): Promise<boolean> {
    if (!ix.viaNull[i]) return true;
    const tb = ix.targetBook[i]!;
    let ok = memo.get(tb);
    if (ok === undefined) {
      ok = !(await this.libraryHas(this.booksById.get(tb)?.title ?? ""));
      memo.set(tb, ok);
    }
    return ok;
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
    const out = (await Promise.all(rows.map((r) => this.externalToLink(r, false)))).filter((l): l is Link => !!l);
    // links INTO these lines from this database's own books — only once the scan that finds them has been made
    // (the listing builds it; a click on a line must not wait for a scan of the whole table)
    if (this.internalLinks) {
      const ix = await this.internalLinks;
      const at = ix.range.get(bookId);
      if (at) {
        const ids: number[] = [];
        const memo = new Map<number, boolean>();
        for (let i = at[0]; i < at[1]; i++) if (ix.targetLine[i]! >= from && ix.targetLine[i]! <= to && ix.sourceBook[i] !== bookId && (await this.reachesOwn(ix, i, memo))) ids.push(ix.rowid[i]!);
        out.push(...(await Promise.all((await this.ext!.byRowids(ids)).map((r) => this.externalToLink(r, false)))).filter((l): l is Link => !!l));
      }
    }
    return out;
  }

  /**
   * A book's links from external_link: the outgoing rows from idx_external_link_source and, from the one
   * table scan, the links into it from this database's own books. Compact rows only; a page resolves its own
   * targets (the registry, by title and heRef) when it is shown.
   */
  private async buildExternalListing(id: number, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void }): Promise<ListingPart> {
    // a row that cannot be placed (no targetLineIndex, and no ref that an open book resolves) is no link: it is left
    // out of the counts exactly as externalToLink leaves it out of the pages
    const rows: ExternalLinkRow[] = [];
    for (const r of await this.ext!.outgoing(id, ctx)) if (r.targetLine !== null || (await this.lineOf(r)) !== null) rows.push(r); // only a row with no targetLineIndex needs its ref resolved here
    const ix = await this.internal(ctx);
    const toc = await this.tocLines();
    const incoming: number[] = [];
    const at = ix.range.get(id);
    const memo = new Map<number, boolean>();
    if (at) for (let i = at[0]; i < at[1]; i++) if (ix.sourceBook[i] !== id && (await this.reachesOwn(ix, i, memo))) incoming.push(i);
    const n = rows.length + incoming.length;
    const keys: string[] = [];
    const keyAt = new Map<string, number>();
    const slot = (key: string) => keyAt.get(key) ?? (keyAt.set(key, keys.length), keys.push(key) - 1);
    const lis = { ref: new Float64Array(n), dir: new Uint8Array(n), other: new Int32Array(n), type: new Uint8Array(n), ownIndex: new Int32Array(n), flags: new Uint8Array(n) };
    const otherLine = new Int32Array(n).fill(-1);
    let k = 0;
    for (const r of rows) {
      const key = (await this.targetBook(r))?.key ?? `unresolved:${r.targetTitle}`;
      // external rows are told from link-table rows by the sign of their ref (a row has no id of its own): -rowid
      lis.ref[k] = -r.rowid;
      lis.dir[k] = 0;
      lis.other[k] = slot(key);
      lis.type[k] = CONNECTION_TYPES.indexOf(this.ext!.typeOf(r.typeName));
      lis.ownIndex[k] = r.lineIndex;
      lis.flags[k] = await this.flagsOf(r, ix, toc);
      if (r.targetLine !== null && !r.targetRef?.trim()) otherLine[k] = r.targetLine;
      k++;
    }
    const ownTitle = this.booksById.get(id)?.title ?? "";
    for (const i of incoming) {
      lis.ref[k] = -ix.rowid[i]!;
      lis.dir[k] = 1;
      lis.other[k] = slot(this.keyOf(ix.sourceBook[i]!));
      lis.type[k] = ix.type[i]!;
      lis.ownIndex[k] = ix.targetLine[i]!;
      lis.flags[k] = await this.flagsOf({ rowid: ix.rowid[i]!, bookId: ix.sourceBook[i]!, lineIndex: ix.sourceLine[i]!, targetSource: this.libraryId ?? null, targetTitle: ownTitle, targetRef: null, targetLine: ix.targetLine[i]!, typeName: null }, ix, toc);
      otherLine[k] = ix.sourceLine[i]!;
      k++;
    }
    return {
      rows: lis,
      otherLine,
      keys,
      fetch: async (refs) => {
        const got = new Map<number, Link>();
        for (const r of await this.ext!.byRowids(refs.map((x) => Math.abs(x)))) {
          const l = await this.externalToLink(r, true);
          if (l) got.set(r.rowid, l);
        }
        return refs.map((x) => got.get(Math.abs(x))).filter((l): l is Link => !!l);
      },
      method: this.ext!.indexed ? "index" : "scan",
    };
  }

  /**
   * One external_link row as a link in its STORED direction (own book → target). The target line is the heRef's
   * line in the target book when the row has a ref and the book is open (the library renumbers lines between
   * versions, a ref survives), else targetLineIndex. A target that is in no open source keeps its title (it is
   * bound when that source opens) and the ref as its place name; nothing is guessed.
   */
  /** the target line of a row: the heRef's line in an open target book, else targetLineIndex; null when neither */
  private async lineOf(r: ExternalLinkRow, book?: BookRef | null): Promise<number | null> {
    if (r.targetLine !== null && !r.targetRef?.trim()) return r.targetLine;
    const b = book === undefined ? await this.targetBook(r) : book;
    if (b && r.targetRef?.trim() && !b.key.startsWith(`${this.info.id}:`)) return (await this.resolver?.lineOfRef(b.key, r.targetRef)) ?? r.targetLine;
    return r.targetLine;
  }

  private async externalToLink(r: ExternalLinkRow, withFlags: boolean): Promise<Link | null> {
    const book = await this.targetBook(r);
    const line = await this.lineOf(r, book);
    // no targetLineIndex and a ref that no open book resolves: the line is unknown, and a link to a guessed line is worse than none (AGENTS §8)
    if (line === null) return null;
    const target: BookRef = book ?? { key: `unresolved:${r.targetTitle}`, title: r.targetTitle, origin: "unknown" };
    // the flags are read from the scan and the table of contents the listing built (a page is shown after it)
    const bits = withFlags ? await this.flagsOf(r, this.internalLinks ? await this.internalLinks : null, await this.tocLines()) : 0;
    const dbFlags = DB_LINK_FLAGS.filter((_, i) => (bits >> i) & 1);
    return {
      id: `${this.info.id}:ext:${r.rowid}`,
      status: "existing",
      provenance: "db",
      source: { book: this.bookRef(r.bookId), line: r.lineIndex },
      target: { book: target, line },
      declaredType: canonicalTypeString(this.ext!.typeOf(r.typeName)),
      heRef2: r.targetRef?.trim() ? r.targetRef : `${target.title} ${line + 1}`,
      ...(dbFlags.length && { dbFlags }),
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
    this.targets.clear();
    this.libraryTitles.clear();
    this.toc = null;
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

interface ResolvedTarget {
  book: BookRef | null;
  /** the target is a book of this very database */
  own: boolean;
  bookId?: number;
  lineCount?: number;
}

/** One table's part of a book's links: compact rows plus how to fetch the full links of a page. */
interface ListingPart {
  rows: ListingRows;
  /** 0-based line at the other end where the row says it without a lookup, else -1 (for the merge of two tables) */
  otherLine: Int32Array;
  keys: string[];
  /** a ref of this part (a link id; for external_link -rowid) → the links, in order */
  fetch: (refs: number[]) => Promise<Link[]>;
  method: "index" | "scan";
}

/** The same link in two tables: same stored ends (book and line) and type. */
const sameLink = (a: Link, b: Link) => a.source.book.key === b.source.book.key && a.source.line === b.source.line && a.target.book.key === b.target.book.key && a.target.line === b.target.line && a.declaredType === b.declaredType;

/**
 * One listing from the parts of a book: one part is its own listing; two (a database with a `link` table AND
 * `external_link`) are concatenated, a ref telling which table it is from by its sign, and an external row that
 * repeats a `link` row (same own line, other book, other line, type; known for rows that point out) is dropped.
 */
function mergeParts(bookKey: string, parts: ListingPart[], ms: number): LinkListing {
  if (parts.length === 1) return new LinkListing(bookKey, parts[0]!.rows, parts[0]!.keys, parts[0]!.fetch, parts[0]!.method, ms);
  const [link, ext] = parts as [ListingPart, ListingPart];
  const keys = [...link.keys];
  const keyAt = new Map(keys.map((k, i) => [k, i]));
  const slot = (k: string) => keyAt.get(k) ?? (keyAt.set(k, keys.length), keys.push(k) - 1);
  const seen = new Set<string>();
  for (let i = 0; i < link.rows.ref.length; i++) if (link.rows.dir[i] === 0 && link.otherLine[i]! >= 0) seen.add(`${link.rows.ownIndex[i]}|${link.keys[link.rows.other[i]!]}|${link.otherLine[i]}|${link.rows.type[i]}`);
  const keep: number[] = [];
  for (let i = 0; i < ext.rows.ref.length; i++) {
    const dup = ext.rows.dir[i] === 0 && ext.otherLine[i]! >= 0 && seen.has(`${ext.rows.ownIndex[i]}|${ext.keys[ext.rows.other[i]!]}|${ext.otherLine[i]}|${ext.rows.type[i]}`);
    if (!dup) keep.push(i);
  }
  const nl = link.rows.ref.length;
  const n = nl + keep.length;
  const rows = { ref: new Float64Array(n), dir: new Uint8Array(n), other: new Int32Array(n), type: new Uint8Array(n), ownIndex: new Int32Array(n), flags: new Uint8Array(n) };
  for (let i = 0; i < nl; i++) {
    rows.ref[i] = link.rows.ref[i]!;
    rows.dir[i] = link.rows.dir[i]!;
    rows.other[i] = link.rows.other[i]!;
    rows.type[i] = link.rows.type[i]!;
    rows.ownIndex[i] = link.rows.ownIndex[i]!;
  }
  keep.forEach((i, j) => {
    rows.ref[nl + j] = ext.rows.ref[i]!;
    rows.dir[nl + j] = ext.rows.dir[i]!;
    rows.other[nl + j] = slot(ext.keys[ext.rows.other[i]!]!);
    rows.type[nl + j] = ext.rows.type[i]!;
    rows.ownIndex[nl + j] = ext.rows.ownIndex[i]!;
    rows.flags[nl + j] = ext.rows.flags?.[i] ?? 0;
  });
  return new LinkListing(
    bookKey,
    rows,
    keys,
    async (refs) => {
      const [a, b] = await Promise.all([link.fetch(refs.filter((x) => x > 0)), ext.fetch(refs.filter((x) => x < 0))]);
      const byId = new Map([...a, ...b].map((l) => [l.id, l]));
      const sid = bookKey.split(":")[0];
      return refs.map((x) => byId.get(x > 0 ? `${sid}:link:${x}` : `${sid}:ext:${-x}`)).filter((l): l is Link => !!l);
    },
    link.method === "index" && ext.method === "index" ? "index" : "scan",
    ms,
  );
}
