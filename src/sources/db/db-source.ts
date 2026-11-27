import { MAX_BOOK_LINES } from "../../core/limits";
import { CONNECTION_TYPES, canonicalTypeString } from "../../core/links/connection-type";
import { CoverageEndsBuilder, coverageEndsOf, type CoverageEnds } from "../../core/links/coverage-ends";
import { linkMatchIndex, matchList, type LinkMatchList } from "../../core/links/equality";
import { DB_LINK_FLAGS, type BookOrigin, type BookRef, type DbLinkFlag, type DbLinkTable, type Link } from "../../core/links/model";
import { headingLevel } from "../../core/text/html";
import type { LibraryAltTocStructure } from "../../core/alt-toc/model";
import { readAltToc } from "../../database/otzaria/alt-toc-reader";
import { ExternalLinksReader, type ExternalLinkRow, type InternalLinks } from "../../database/otzaria/external-links-reader";
import { DbLinksReader, type DbLinkRow } from "../../database/otzaria/links-reader";
import { OtzariaDbReader, type DbBook, type DbLine } from "../../database/otzaria/reader";
import { UserLinksReader, type UserLinkIndex, type UserLinkRow, type UserLinkSide } from "../../database/otzaria/user-links-reader";
import { TocLines } from "../../database/otzaria/toc-lines";
import type { ByteSource } from "../../database/sqlite/lazy/byte-source";
import type { BookSource, LineChunk, SourceBook, SourceInfo, SourceLine } from "../book-source";
import type { ExternalTargetResolver } from "./external-target";
import { LinkListing, type ListingRows } from "./link-listing";
import { SharedRun, type RunContext } from "./shared-run";

/*
 * An Otzaria-family database as a book source. Read-only by construction: nothing here can write.
 * Existing links come back in the STORED direction with provenance "db" — they are shown, checked
 * and compared, but never re-exported as if a links file had said them (LINK_FORMATS §4.4).
 */
export class DbBookSource implements BookSource {
  private booksById = new Map<number, DbBook>();
  /** listings of the last few books shown in the links panel (a big base book holds ~235k links) */
  private readonly listings = new Map<number, SharedRun<LinkListing>>();
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
    /** the personal links of Otzaria's user_books.db (`user_link`, Issue #41 B20) */
    private readonly user: UserLinksReader | null = null,
  ) {}

  /** where an external_link row's target lives (other sources): set by the registry, absent in a lone source */
  private resolver: ExternalTargetResolver | null = null;
  /** the links between books of this database, from one scan of external_link (built on demand, cached) */
  private internalRun: SharedRun<InternalLinks> | null = null;
  /** why external_link is not read, when the database has one that cannot be (open() warned already) */
  private extProblem = "";
  /** why user_link is not read, when the database has one that cannot be (open() warned already, db/user-link-not-read): every count of a book is then partial */
  private userProblem = "";
  private titleToId: Map<string, number> | null = null;

  static async open(id: string, label: string, src: ByteSource): Promise<DbBookSource> {
    const reader = await OtzariaDbReader.open(src, label);
    // the reader holds the database's dictionaries in the worker's pool: a failure past this point must release them,
    // or they stay there (and can make a dictionary id conflicted) for the rest of the session (Issue #41 C3)
    try {
      return await DbBookSource.build(id, label, reader);
    } catch (err) {
      reader.close();
      throw err;
    }
  }

  private static async build(id: string, label: string, reader: OtzariaDbReader): Promise<DbBookSource> {
    const links = await DbLinksReader.open(reader.file, reader.caps);
    // a database with both tables lists the links of both, each once (mergeParts); external_link alone is a personal database (#13)
    const extProblems: { code: string; message: string }[] = [];
    const ext = await ExternalLinksReader.open(reader.file, reader.caps, (p) => extProblems.push(p));
    const userProblems: { code: string; message: string }[] = [];
    const user = await UserLinksReader.open(reader.file, reader.caps, (p) => userProblems.push(p));
    const warnings = [...reader.caps.warnings, ...extProblems, ...userProblems];
    if (ext && !ext.indexed)
      warnings.push({ code: "db/external-links-unindexed", message: "לטבלת הקישורים החיצוניים (external_link) במסד אין אינדקס לפי ספר, ולכן הצגת הקישורים של ספר תסרוק את כל הטבלה: איטי במסד גדול. כדי להאיץ, צרו במסד אינדקס על (sourceBookId, sourceLineIndex) בכלי שיצר אותו." });
    if (links && !links.indexed)
      warnings.push({ code: "db/links-unindexed", message: "לטבלת הקישורים במסד אין אינדקס לפי שורה, ולכן הצגת קישורים קיימים תהיה איטית במסד גדול." });
    const s = new DbBookSource({ id, kind: "otzaria-db", label, warnings }, reader, links, ext, user);
    s.extProblem = extProblems.map((p) => p.message).join(" ");
    s.userProblem = userProblems.map((p) => p.message).join(" ");
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
      // the table is there but not read: which books have links in it is not known, so none of them may look like a book with none
      ...(this.userProblem && { linksUnread: this.userProblem }),
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
    const id = this.idOf(bookKey);
    const parts: Link[][] = [];
    if (this.links) {
      const lines = await this.reader.lineEntries(id);
      const ids = lines.filter((e) => e.index >= from && e.index <= to).map((e) => e.id);
      parts.push((await this.links.atLines(ids)).map((r) => this.toLink(r)));
    }
    if (this.ext) parts.push(await this.externalLinksAt(id, from, to));
    if (this.user) parts.push(await this.userLinksAt(id, from, to));
    // each table's links, a link that a table before it already gave dropped (the same rule as the listing's merge, mergeParts)
    const out: Link[] = [];
    for (const part of parts) {
      const before = out.slice();
      for (const l of part) if (!before.some((k) => sameLink(k, l))) out.push(l);
    }
    return out;
  }

  /**
   * For each run [from, to], the match index of existingLinks(bookKey, from, to) (V7 round 2 item 11; docs/reviews/V7_PERFORMANCE.md
   * §10): every run's lines in ONE read of the `link` table's line indexes and rows, split back into the runs by the lines each link
   * was found by, and without the anchors, range ends and suppressed sides existingLinks() attaches (no part of the identity). A
   * database whose links are also (or only) in external_link or user_link, or without the line indexes, returns null: the registry
   * then reads existingLinks() run by run — so the result is always the same as the run-by-run read.
   */
  async existingMatchIndexes(bookKey: string, runs: readonly (readonly [number, number])[], signal?: AbortSignal): Promise<LinkMatchList[] | null> {
    if (!this.links || this.ext || this.user || !this.links.indexed) return null;
    // a cancel stops the read between its reads (V7 round 2 review, finding 11): the line entries, each index walk, the link rows and
    // the line rows (atLinesBare); not inside one, which is a single ordered walk
    signal?.throwIfAborted();
    const id = this.idOf(bookKey);
    const entries = [...(await this.reader.lineEntries(id))].sort((a, b) => a.index - b.index);
    signal?.throwIfAborted();
    // the line ids of each run, as existingLinks() selects them (index in [from, to]); a line id → the runs it is in
    const runsOf = new Map<number, number[]>();
    runs.forEach(([from, to], r) => {
      let lo = 0;
      let hi = entries.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (entries[mid]!.index < from) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < entries.length && entries[i]!.index <= to; i++) {
        const lineId = entries[i]!.id;
        const at = runsOf.get(lineId);
        if (at) at.push(r);
        else runsOf.set(lineId, [r]);
      }
    });
    const read = await this.links.atLinesBare(runsOf.keys(), signal);
    if (!read) return null;
    signal?.throwIfAborted();
    const perRun = runs.map(() => [] as Link[]);
    for (const row of read.rows) {
      const link = this.toLink(row);
      const into = new Set<number>();
      for (const lineId of read.foundBy.get(row.id) ?? []) for (const r of runsOf.get(lineId) ?? []) into.add(r);
      for (const r of into) perRun[r]!.push(link);
    }
    return perRun.map((links) => matchList(linkMatchIndex(links)));
  }

  /**
   * The book's links as the coverage rules read them (core/links/coverage-ends.ts, #42 C7, C8): from the link table's book
   * indexes (bookLinks), the line indexes of the other ends that are not stored on the link, and the range ends — no anchor, no
   * heRef, no Link object. existingLinks() of בראשית built 235,898 Links in the worker and sent them all to the page. The
   * numbers are the ones toLink() gives (the same lines, the same rangeEnd clamp, the same titles). A database whose links are
   * also (or only) in external_link or user_link is read through existingLinks(), and compacted here.
   */
  async coverageEnds(bookKey: string, ctx: { signal?: AbortSignal } = {}): Promise<CoverageEnds> {
    if (!this.links || this.ext || this.user) return coverageEndsOf(await this.existingLinks(bookKey, 0, Number.MAX_SAFE_INTEGER), (r) => r.key === bookKey);
    const id = this.idOf(bookKey);
    const rows = await this.links.bookLinks(id, ctx);
    ctx.signal?.throwIfAborted();
    const own = new Map((await this.reader.lineEntries(id)).map((e) => [e.id, e.index]));
    const n = rows.ids.length;
    // the line index of a stored SOURCE end is not on the link: read from the line table (a stored target's is targetLineIndex)
    const need: number[] = [];
    for (let i = 0; i < n; i++) if (rows.dir[i] === 1 || rows.other[i] === id || Number.isNaN(rows.targetIndex[i]!)) need.push(rows.otherLineId[i]!);
    const lineOf = await this.links.lineIndexes(need);
    ctx.signal?.throwIfAborted();
    const ranges = await this.links.rangeEnds(Array.from(rows.ids));
    ctx.signal?.throwIfAborted();
    const title = (bookId: number) => this.booksById.get(bookId)?.title ?? `#${bookId}`;
    const total = (bookId: number) => this.booksById.get(bookId)?.totalLines ?? null;
    const out = new CoverageEndsBuilder();
    for (let i = 0; i < n; i++) {
      const linkId = rows.ids[i]!;
      const range = ranges.get(linkId);
      const ownId = rows.ownLine[i]!;
      const otherId = rows.otherLineId[i]!;
      const tIndex = rows.targetIndex[i]!;
      // the stored source and target ends, as toLink() reads them
      const isOut = rows.dir[i] === 0;
      const srcBook = isOut ? id : rows.other[i]!;
      const tgtBook = isOut ? rows.other[i]! : id;
      const srcLine = isOut ? own.get(ownId) : lineOf.get(otherId);
      const tgtLine = !Number.isNaN(tIndex) ? tIndex : isOut ? lineOf.get(otherId) : own.get(ownId);
      // a link the by-line read would not find: its end in this book is not one of the book's lines
      if ((isOut ? srcLine : own.get(ownId)) === undefined) continue;
      out.links++;
      const s = srcLine ?? -1;
      const t = tgtLine ?? -1;
      const sEnd = rangeEnd(s, range?.[0], total(srcBook)) ?? s;
      const tEnd = rangeEnd(t, range?.[1], total(tgtBook)) ?? t;
      if (srcBook === id) out.add(s, sEnd, title(tgtBook), t, tEnd);
      if (tgtBook === id) out.add(t, tEnd, title(srcBook), s, sEnd);
    }
    return out.build();
  }

  /**
   * Every link of a book, from the link table's book indexes (DbLinksReader.bookLinks). The line
   * index of the book's own end comes from the (bookId, lineIndex) index; the other end is read
   * only for the page shown.
   */
  async linkListing(bookKey: string, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}): Promise<LinkListing | string> {
    if (!this.links && !this.ext && !this.user) return `במסד "${this.info.label}" אין טבלת קישורים (link) ואין בו קישורים חיצוניים (external_link). ${[this.extProblem, this.userProblem].filter(Boolean).join(" ") || "ייתכן שזו גרסה ישנה או מסד אישי בלי קישורים."}`;
    const id = this.idOf(bookKey);
    let run = this.listings.get(id);
    if (!run || run.cancelled) {
      // the read is shared by every caller and has its own signal: it stops only when all the callers that can stop it have
      const fresh = new SharedRun((c) => this.buildAnyListing(bookKey, id, c));
      run = fresh;
      this.listings.set(id, fresh);
      fresh.result.catch(() => this.listings.get(id) === fresh && this.listings.delete(id)); // a cancelled or failed read is not cached
      while (this.listings.size > 3) this.listings.delete(this.listings.keys().next().value!);
    }
    return run.join(ctx);
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
    if (this.user) parts.push(await this.buildUserListing(id, ctx));
    return mergeParts(bookKey, parts, Math.round(performance.now() - t0), this.userProblem || undefined);
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
      table: "link",
      rows: { ref: rows.ids, dir: rows.dir, other, type: rows.type, ownIndex },
      otherLine: rows.otherLine,
      keys: others.map((b) => this.keyOf(b)),
      fetch: async (ids) => {
        const got = new Map((await this.links!.byIds(ids)).map((r) => [r.id, this.toLink(r)]));
        return ids.map((i) => got.get(i));
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
    if (this.ext || this.user) {
      this.listings.clear();
      this.targets.clear();
      this.libraryTitles.clear();
      this.userTargets.clear();
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

  /** the one scan of external_link, shared by every caller (its own signal: see SharedRun); a cancelled or failed scan is not cached */
  private internal(ctx: RunContext = {}): Promise<InternalLinks> {
    if (!this.internalRun || this.internalRun.cancelled) {
      const fresh = new SharedRun((c) => this.ext!.internal(this.libraryId, this.titles(), c, new Set(this.booksById.keys())));
      this.internalRun = fresh;
      fresh.result.catch(() => this.internalRun === fresh && (this.internalRun = null));
    }
    return this.internalRun.join(ctx);
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
    const own = this.booksById.get(r.bookId)?.totalLines;
    if (own != null && r.lineIndex >= own) f |= bit("source-out-of-range");
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
    // links INTO these lines from this database's own books: always, so the answer does not depend on whether the
    // links tab built the scan first (QA round 2, H1). The scan is one pass over the table, shared and kept.
    {
      const ix = await this.internal();
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
    const unlisted = { badLine: 0, noPlace: 0, orphanSource: 0 };
    for (const r of await this.ext!.outgoing(id, ctx)) {
      if (r.badSource) unlisted.badLine++;
      else if (r.targetLine !== null || (await this.lineOf(r)) !== null) rows.push(r); // only a row with no targetLineIndex needs its ref resolved here
      else if (!r.targetRef?.trim()) unlisted[r.badTarget ? "badLine" : "noPlace"]++; // a row with a ref that no open book resolves is not corrupt: it waits for its book
    }
    const ix = await this.internal(ctx);
    const into = ix.unlistedByTarget.get(id);
    if (into) (unlisted.badLine += into.badLine), (unlisted.noPlace += into.noPlace);
    unlisted.orphanSource = ix.orphanSource;
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
      // a database with a link table too compares the two tables by the far line, which a row with a ref has only once the ref is resolved
      else if (this.links) otherLine[k] = (await this.lineOf(r)) ?? -1;
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
      table: "external_link",
      rows: lis,
      otherLine,
      keys,
      fetch: async (refs) => {
        const got = new Map<number, Link>();
        for (const r of await this.ext!.byRowids(refs.map((x) => Math.abs(x)))) {
          const l = await this.externalToLink(r, true);
          if (l) got.set(r.rowid, l);
        }
        return refs.map((x) => got.get(Math.abs(x)));
      },
      method: this.ext!.indexed ? "index" : "scan",
      unlisted,
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
    if (r.badSource) return null; // a source line that is no line: counted in the summary, not a link
    const book = await this.targetBook(r);
    const line = await this.lineOf(r, book);
    // no targetLineIndex and a ref that no open book resolves: the line is unknown, and a link to a guessed line is worse than none (AGENTS §8)
    if (line === null) return null;
    const target: BookRef = book ?? { key: `unresolved:${r.targetTitle}`, title: r.targetTitle, origin: "unknown" };
    // the flags are read from the scan and the table of contents the listing built (a page is shown after it)
    const bits = withFlags ? await this.flagsOf(r, await this.internal(), await this.tocLines()) : 0;
    const dbFlags = DB_LINK_FLAGS.filter((_, i) => (bits >> i) & 1);
    return {
      id: `${this.info.id}:ext:${r.rowid}`,
      status: "existing",
      provenance: "db",
      dbTable: "external_link",
      source: { book: this.bookRef(r.bookId), line: r.lineIndex },
      target: { book: target, line },
      declaredType: canonicalTypeString(this.ext!.typeOf(r.typeName)),
      heRef2: r.targetRef?.trim() ? r.targetRef : `${target.title} ${line + 1}`,
      ...(dbFlags.length && { dbFlags }),
    };
  }

  /* ---------------- user_link (Otzaria's user_books.db, Issue #41 B20) ---------------- */

  /** the one scan of user_link, shared by every caller (its own signal: see SharedRun); a cancelled or failed scan is not cached */
  private userRun: SharedRun<UserLinkIndex> | null = null;
  /** a side that is not a book of this database → the open book it names (memoized; cleared when the open sources change) */
  private readonly userTargets = new Map<string, Promise<ResolvedTarget>>();
  /** this database's books by exact title, every id of the title, lowest first */
  private ownByTitle: Map<string, number[]> | null = null;

  private userIndex(ctx: RunContext = {}): Promise<UserLinkIndex> {
    if (!this.userRun || this.userRun.cancelled) {
      const fresh = new SharedRun((c) => this.user!.index((side) => this.ownOf(side), c));
      this.userRun = fresh;
      fresh.result.catch(() => this.userRun === fresh && (this.userRun = null));
    }
    return this.userRun.join(ctx);
  }

  /**
   * The book of THIS database a user_link side names (UserLinksReader OwnBookOf). A personal side (flag 1, no attached database) is
   * its exact title, narrowed by the row's category when it has one (NULL = any, user_content_repository.dart:565-567; two books of
   * the title and no category: the first, lowest id); a "book-id" source is its id (-2: no such book). A library or attached side
   * is never a book of this database, whatever its title (B20: never bound to a same-titled book of the other kind). A side whose
   * flag is unknown names the book of its title, so that the row is counted there as not a link (it is never listed).
   */
  private ownOf(side: UserLinkSide): number {
    if (side.bookId !== null) return this.booksById.has(side.bookId) ? side.bookId : -2;
    if (side.db !== null || side.user === false) return -1;
    if (!this.ownByTitle) {
      const m = new Map<string, number[]>();
      for (const b of [...this.booksById.values()].sort((a, b) => a.id - b.id)) {
        const list = m.get(b.title);
        if (list) list.push(b.id);
        else m.set(b.title, [b.id]);
      }
      this.ownByTitle = m;
    }
    const ids = this.ownByTitle.get(side.title);
    if (!ids) return -1;
    if (side.category === null || side.user === null) return ids[0]!;
    return ids.find((id) => this.booksById.get(id)?.categoryId === side.category) ?? -1;
  }

  /**
   * The open book a side that is not this database's names: the library's book of that title (flag 0), or the book of an attached
   * database named by its slug. A PERSONAL side this database does not have is in no other source (only user_books.db holds the
   * app's personal books): it stays unresolved. Nothing is bound across kinds.
   */
  private userTarget(side: UserLinkSide): Promise<ResolvedTarget> {
    const memo = `${side.user}\u0000${side.db ?? ""}\u0000${side.title}`;
    let p = this.userTargets.get(memo);
    if (!p) {
      p = (async (): Promise<ResolvedTarget> => {
        if (side.user !== false && side.db === null) return { book: null, own: false };
        const t = await this.resolver?.book(side.title, side.db ?? "official", this.info.id, side.db === null ? "library-id" : "slug");
        return t ? { book: { key: t.key, title: t.title, origin: t.origin, ...(t.isBaseBook !== undefined && { isBaseBook: t.isBaseBook }) }, own: false, ...(t.lineCount !== undefined && { lineCount: t.lineCount }) } : { book: null, own: false };
      })();
      this.userTargets.set(memo, p);
    }
    return p;
  }

  /** a side no open source has: its title alone, with the KIND the row gives it (a personal title never binds to a library book, B18) */
  private unresolvedSide(side: UserLinkSide): BookRef {
    return { key: `unresolved:${side.title}`, title: side.title, origin: side.user !== false || side.db !== null ? "personal" : "otzaria" };
  }

  /** A book's user_link rows: those that start in it ("out"), and those that end in it and do not start there ("in"). */
  private async buildUserListing(id: number, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void }): Promise<ListingPart> {
    const ix = await this.userIndex(ctx);
    const outs = ix.out.get(id) ?? [];
    const ins = ix.in.get(id) ?? [];
    const n = outs.length + ins.length;
    const keys: string[] = [];
    const keyAt = new Map<string, number>();
    const slot = (key: string) => keyAt.get(key) ?? (keyAt.set(key, keys.length), keys.push(key) - 1);
    const keyOfSide = async (book: number, side: number) => (book >= 0 ? this.keyOf(book) : ((await this.userTarget(ix.sides[side]!)).book?.key ?? `unresolved:${ix.sides[side]!.title}`));
    const lis = { ref: new Float64Array(n), dir: new Uint8Array(n), other: new Int32Array(n), type: new Uint8Array(n), ownIndex: new Int32Array(n) };
    const otherLine = new Int32Array(n);
    let k = 0;
    for (const [dir, list] of [[0, outs], [1, ins]] as const)
      for (const i of list) {
        lis.ref[k] = ix.rowid[i]!;
        lis.dir[k] = dir;
        lis.other[k] = slot(dir === 0 ? await keyOfSide(ix.targetBook[i]!, ix.targetSide[i]!) : await keyOfSide(ix.sourceBook[i]!, ix.sourceSide[i]!));
        lis.type[k] = ix.type[i]!;
        lis.ownIndex[k] = dir === 0 ? ix.sourceLine[i]! : ix.targetLine[i]!;
        otherLine[k] = dir === 0 ? ix.targetLine[i]! : ix.sourceLine[i]!;
        k++;
      }
    const u = ix.unlistedByBook.get(id);
    return {
      table: "user_link",
      rows: lis,
      otherLine,
      keys,
      fetch: (refs) => this.userLinksByRowid(refs),
      // the table is read once per open database (a scan, then kept); a book's listing is a lookup in memory after that
      method: "index",
      unlisted: { badLine: u?.badLine ?? 0, noPlace: u?.noPlace ?? 0, orphanSource: ix.orphanSource },
    };
  }

  private async userLinksByRowid(rowids: number[]): Promise<(Link | undefined)[]> {
    const got = new Map<number, Link>();
    for (const r of await this.user!.byRowids(rowids)) {
      const l = await this.userToLink(r);
      if (l) got.set(r.rowid, l);
    }
    return rowids.map((x) => got.get(x));
  }

  /** The user_link rows on the lines [from, to] of a book (its own end on those lines; a link inside the book by either end). */
  private async userLinksAt(bookId: number, from: number, to: number): Promise<Link[]> {
    const ix = await this.userIndex();
    const on = (line: number) => line >= from && line <= to;
    const ids: number[] = [];
    for (const i of ix.out.get(bookId) ?? []) if (on(ix.sourceLine[i]!) || (ix.targetBook[i] === bookId && on(ix.targetLine[i]!))) ids.push(ix.rowid[i]!);
    for (const i of ix.in.get(bookId) ?? []) if (on(ix.targetLine[i]!)) ids.push(ix.rowid[i]!);
    return (await this.userLinksByRowid(ids)).filter((l): l is Link => !!l);
  }

  /**
   * One user_link row as a link in its STORED direction (source side → target side), provenance "db", read-only. The ends of a
   * range are clamped like every database range (rangeEnd); the anchor is the source line's raw offsets, as the links file wrote
   * them (RawAnchor). null for a row that is no link (the index counts those as unlisted).
   */
  private async userToLink(r: UserLinkRow): Promise<Link | null> {
    if (r.sourceLine === null || r.targetLine === null || r.source.user === null || r.target.user === null) return null;
    const sb = this.ownOf(r.source);
    const tb = this.ownOf(r.target);
    if (sb === -2) return null;
    const end = async (own: number, side: UserLinkSide): Promise<{ book: BookRef; total: number | null }> => {
      if (own >= 0) return { book: this.bookRef(own), total: this.booksById.get(own)?.totalLines ?? null };
      const t = await this.userTarget(side);
      return { book: t.book ?? this.unresolvedSide(side), total: t.lineCount ?? null };
    };
    const S = await end(sb, r.source);
    const T = await end(tb, r.target);
    const sEnd = rangeEnd(r.sourceLine, r.sourceEnd, S.total);
    const tEnd = rangeEnd(r.targetLine, r.targetEnd, T.total);
    const table: DbLinkTable = "user_link";
    return {
      id: `${this.info.id}:user:${r.rowid}`,
      status: "existing",
      provenance: "db",
      dbTable: table,
      source: { book: S.book, line: r.sourceLine, ...(sEnd !== undefined && { end: sEnd }) },
      target: { book: T.book, line: r.targetLine, ...(tEnd !== undefined && { end: tEnd }) },
      declaredType: canonicalTypeString(this.user!.typeOf(r.typeName)),
      heRef2: r.targetRef?.trim() ? r.targetRef : `${T.book.title} ${r.targetLine + 1}`,
      ...(r.anchor && { anchor: { rawStart: r.anchor.start, ...(r.anchor.end !== undefined && { rawEnd: r.anchor.end }), ...(r.anchor.label && { label: r.anchor.label }) } }),
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
    this.internalRun = null;
    this.userRun = null;
    this.userTargets.clear();
    this.ownByTitle = null;
    this.reader.close();
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
    const end = (e: DbLinkRow["source"]) => {
      const last = rangeEnd(e.lineIndex, e.endIndex, this.booksById.get(e.bookId)?.totalLines ?? null);
      return { book: ref(e.bookId), line: e.lineIndex, ...(last !== undefined && { end: last }) };
    };
    return {
      id: `${this.info.id}:link:${r.id}`,
      status: "existing",
      provenance: "db",
      dbTable: "link",
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

/**
 * The end of a stored range as a link may carry it, or undefined (no range). link_range.endLineIndex comes from a database
 * nobody vouches for, and every loop over a range walks to it (Issue #41 C1: 20,000,000 cost 400+ MB in the max-link job).
 * Only a whole line number past a whole start is an end (an end that is not after its start is ignored, AGENTS §3); one
 * no book can reach (MAX_BOOK_LINES) is dropped, and one past the book's declared length is clamped to its last line.
 */
export function rangeEnd(line: number, end: number | undefined, totalLines: number | null): number | undefined {
  if (end === undefined || !Number.isInteger(line) || line < 0 || !Number.isInteger(end) || end <= line || end >= MAX_BOOK_LINES) return undefined;
  const last = totalLines !== null && totalLines > 0 ? Math.min(end, totalLines - 1) : end;
  return last > line ? last : undefined;
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
  table: DbLinkTable;
  rows: ListingRows;
  /** 0-based line at the other end where the row says it without a lookup, else -1 (for the merge of several tables) */
  otherLine: Int32Array;
  keys: string[];
  /** refs of this part (a link id; for external_link -rowid; for user_link the rowid) → their links, aligned (undefined: none) */
  fetch: (refs: number[]) => Promise<(Link | undefined)[]>;
  method: "index" | "scan";
  /** external_link / user_link rows of the book that could not be listed (see DbLinkSummary.unlisted) */
  unlisted?: { badLine: number; noPlace: number; orphanSource: number };
}

/** The same link in two tables: same stored ends (book and line) and type. */
const sameLink = (a: Link, b: Link) => a.source.book.key === b.source.book.key && a.source.line === b.source.line && a.target.book.key === b.target.book.key && a.target.line === b.target.line && a.declaredType === b.declaredType;

/**
 * One listing from the parts of a book (`link`, `external_link`, `user_link`, in this order, each that the database has). One
 * part is its own listing. Several are concatenated, and a row of a later table that repeats a row of an earlier one (same
 * direction, own line, other book, other line and type; known only where the row says its far line: `link` only for the rows that
 * point out) is dropped. A merged row's ref is its position; a page asks each table for its own rows. `unread`: why some of the
 * book's links were not read at all (DbLinkSummary.unread).
 */
function mergeParts(bookKey: string, parts: ListingPart[], ms: number, unread?: string): LinkListing {
  const sumUnlisted = (list: ListingPart[]) => {
    const u = list.filter((p) => p.unlisted).map((p) => p.unlisted!);
    return u.length ? { badLine: u.reduce((n, x) => n + x.badLine, 0), noPlace: u.reduce((n, x) => n + x.noPlace, 0), orphanSource: u.reduce((n, x) => n + x.orphanSource, 0) } : undefined;
  };
  if (parts.length === 1) {
    const p = parts[0]!;
    return new LinkListing(bookKey, p.rows, p.keys, async (refs) => (await p.fetch(refs)).filter((l): l is Link => !!l), p.method, ms, p.unlisted, undefined, unread);
  }
  const keys: string[] = [];
  const keyAt = new Map<string, number>();
  const slot = (k: string) => keyAt.get(k) ?? (keyAt.set(k, keys.length), keys.push(k) - 1);
  const seen = new Set<string>();
  const kept: [part: number, row: number][] = [];
  let duplicatesDropped = 0;
  const keyOf = (p: ListingPart, i: number) => `${p.rows.dir[i]}|${p.rows.ownIndex[i]}|${p.keys[p.rows.other[i]!]}|${p.otherLine[i]}|${p.rows.type[i]}`;
  parts.forEach((p, pi) => {
    const mine: string[] = [];
    for (let i = 0; i < p.rows.ref.length; i++) {
      const known = p.otherLine[i]! >= 0;
      if (known && seen.has(keyOf(p, i))) {
        duplicatesDropped++;
        continue;
      }
      if (known) mine.push(keyOf(p, i));
      kept.push([pi, i]);
    }
    // rows of one table are never dropped as repeats of each other (two rows there are two links of the database)
    for (const k of mine) seen.add(k);
  });
  const n = kept.length;
  const rows = { ref: new Float64Array(n), dir: new Uint8Array(n), other: new Int32Array(n), type: new Uint8Array(n), ownIndex: new Int32Array(n), flags: new Uint8Array(n) };
  kept.forEach(([pi, i], g) => {
    const p = parts[pi]!;
    rows.ref[g] = g;
    rows.dir[g] = p.rows.dir[i]!;
    rows.other[g] = slot(p.keys[p.rows.other[i]!]!);
    rows.type[g] = p.rows.type[i]!;
    rows.ownIndex[g] = p.rows.ownIndex[i]!;
    rows.flags[g] = p.rows.flags?.[i] ?? 0;
  });
  const keptOf = (t: DbLinkTable) => kept.filter(([pi]) => parts[pi]!.table === t).length;
  const link = parts.find((p) => p.table === "link");
  const linkHasIncoming = !!link && link.rows.dir.some((x) => x === 1);
  const tables = {
    link: keptOf("link"),
    externalLink: keptOf("external_link"),
    duplicatesDropped,
    // an incoming row of another table has no known far line on the link side, so it is not compared; say so when there is anything to compare it with
    incomingUnchecked: linkHasIncoming ? kept.filter(([pi, i]) => parts[pi]!.table !== "link" && parts[pi]!.rows.dir[i] === 1).length : 0,
    ...(parts.some((p) => p.table === "user_link") && { userLink: keptOf("user_link") }),
  };
  return new LinkListing(
    bookKey,
    rows,
    keys,
    async (refs) => {
      const got = new Map<number, Link>();
      for (let pi = 0; pi < parts.length; pi++) {
        const mine = refs.filter((g) => kept[g]![0] === pi);
        if (!mine.length) continue;
        const links = await parts[pi]!.fetch(mine.map((g) => parts[pi]!.rows.ref[kept[g]![1]]!));
        mine.forEach((g, j) => links[j] && got.set(g, links[j]));
      }
      return refs.map((g) => got.get(g)).filter((l): l is Link => !!l);
    },
    parts.every((p) => p.method === "index") ? "index" : "scan",
    ms,
    sumUnlisted(parts),
    tables,
    unread,
  );
}
