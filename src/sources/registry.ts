import type { LibraryAltTocStructure } from "../core/alt-toc/model";
import type { BookHeading, SourceBook, SourceInfo, SourceLine } from "../core/books";
import type { DbMapping, MappingTest, PendingDb } from "../core/db-mapping";
import { sourceIdOfBookKey } from "../core/books";
import { LinkerError } from "../core/errors";
import type { Link } from "../core/links/model";
import type { DbLinkPage, DbLinkQuery, DbLinkSummary, DbLinksUnavailable } from "../core/links/db-links";
import { decodeText } from "../core/text/decode";
import { SEFARIA_TITLES_PATH } from "../core/links/sefaria-owned";
import { parseRecords } from "../formats/records/records";
import { stripTags } from "../core/text/html";
import { sharedDictionaries } from "../database/compression/zstd";
import { sha256Hex } from "../database/compression/sha256";
import { blobSource } from "../database/sqlite/lazy/byte-source";
import { safeUnzip } from "./archives/safe-unzip";
import type { BookSource, LineChunk } from "./book-source";
import { DbBookSource } from "./db/db-source";
import { otzariaSlug, type ExternalTargetResolver, type TargetBook } from "./db/external-target";
import { MappedDbSource, testMapping } from "./db/mapped-source";
import { pendingMapping } from "./db/pending";
import { listingFromLinks, type LinkListing } from "./db/link-listing";
import { detectKind, type DetectedKind } from "./detect";
import { loneCrMessage, TextFilesSource, type TextFile } from "./text/text-source";

/*
 * Everything the user has opened, behind one door (stage 6). The user drops files without saying
 * what they are; each file is classified by content (detect.ts), books become sources, and
 * links/project files are handed back as text for the state layer to import.
 */

/** One file the user gave: a dropped/picked File, with its path inside a picked folder. */
export interface InputFile {
  /** relative path ("folder/sub/x.txt") or just the name */
  path: string;
  blob: Blob;
}

export interface OpenedSource {
  info: SourceInfo;
  books: SourceBook[];
}

export interface OpenResult {
  sources: OpenedSource[];
  /** links files and project files, as decoded text — imported by the state layer */
  documents: { path: string; kind: "links-json" | "links-csv" | "alt-toc-json" | "project" | "records"; text: string }[];
  /** files that were not opened, each with a reason the user can act on */
  skipped: { path: string; reason: string }[];
  /** SQLite files not in Otzaria's schema: opened through openMapped once the user maps them */
  needsMapping?: PendingDb[];
  /** zstd dictionaries opened as files: books compressed with them can now be read (see DictionaryPool) */
  dictionaries?: { path: string; id: number }[];
  /** databases that were already open (the same file picked again): not opened a second time, listed here instead (#22) */
  reused?: (OpenedSource & { as?: string })[];
}

const HEAD = 4096;
/** heRef → line maps kept for resolving external_link targets: about 400K entries (tens of MB at most) in all */
const REF_INDEX_BUDGET = 400_000;
const MAX_TEXT_DOC = 256 * 1024 ** 2;
/** how much of a book is read to tell its encoding when it opens */
const SNIFF = 64 * 1024;
/** a ZIP is read whole into memory to be inflated, so its size is capped first */
const MAX_ZIP = 512 * 1024 ** 2;
/** listings of the last few books shown in the links panel of a mapped database (see fallbackListings) */
const FALLBACK_LISTINGS = 3;

export class SourceRegistry {
  private readonly sources = new Map<string, BookSource>();
  /** databases waiting for (or opened with) a mapping, by token — a few File handles, no data */
  private readonly pending = new Map<string, { blob: Blob; label: string; identity?: string }>();
  /** the mapping each open mapped database was opened with (JSON), to tell "the same again" from "another mapping" */
  private readonly mappingOf = new Map<string, string>();
  /**
   * The identity of each open database file → its source id, and back (to release it on close). Picking the
   * same file twice must not load it twice: two sources would list every book twice and hold the file twice
   * in the worker (#22). The identity is the file's name, size, last-modified time and the 100-byte SQLite
   * header (page size, file change counter, size in pages, schema cookie — it changes whenever the file does).
   */
  private readonly byIdentity = new Map<string, string>();
  private readonly identityOf = new Map<string, string>();
  private seq = 0;
  private idPrefix = "s";
  /**
   * listings built from existingLinks() for sources without their own (mapped databases), by book key, in LRU order and
   * at most FALLBACK_LISTINGS of them: each holds every link of its book (Issue #42 C4), like DbBookSource's own listings
   */
  private readonly fallbackListings = new Map<string, Promise<LinkListing>>();
  /** per source: its books by exact title (a personal database's external_link names its targets by title) */
  private readonly titleIndexes = new Map<string, Promise<Map<string, SourceBook>>>();
  /** per book key: heRef → 0-based line, for the books external_link rows were resolved in (a few at a time) */
  private readonly refIndexes = new Map<string, Promise<Map<string, number>>>();
  /** entries of each finished ref index: the cache is capped by their SUM (a big book's map is megabytes), see REF_INDEX_BUDGET */
  private readonly refIndexSizes = new Map<string, number>();
  private readonly resolver: ExternalTargetResolver = {
    book: (title, targetSource, from, by) => this.findTarget(title, targetSource, from, by),
    lineOfRef: async (bookKey, heRef) => (await this.refIndex(bookKey)).get(heRef) ?? null,
  };

  async open(files: readonly InputFile[], signal?: AbortSignal): Promise<OpenResult> {
    const result: OpenResult = { sources: [], documents: [], skipped: [] };
    const texts: TextFile[] = [];
    const notUtf8: string[] = [];
    /** text files with a CR not followed by LF in their first bytes (#41 B10): warned at open, where the store shows warnings */
    const loneCr: string[] = [];
    for (const f of files) {
      signal?.throwIfAborted();
      const kind = detectKind(new Uint8Array(await f.blob.slice(0, HEAD).arrayBuffer()), f.path);
      await this.route(f, kind, result, texts, notUtf8, signal, loneCr);
    }
    if (texts.length) {
      const src = new TextFilesSource(this.nextId(), labelForTexts(texts), texts);
      // a checkout of the library carries its list of Sefaria titles: its books are the library's (sefaria-titles.ts)
      if (files.some((f) => f.path.replace(/\\/g, "/").endsWith(SEFARIA_TITLES_PATH))) src.info.library = true;
      // decided at open time: a warning added on first read (inside the source) never reached the UI
      // #42 C29: an empty file used to open as a book with no lines and no word about it
      const empty = files.filter((f) => f.blob.size === 0 && texts.some((t) => t.path === f.path)).map((f) => f.path);
      if (empty.length)
        src.info.warnings.push({ code: "source/empty-file", message: empty.length === 1 ? `הקובץ "${empty[0]}" ריק — אין בו שורות לקשר. בדקו שבחרתם את הקובץ הנכון.` : `${empty.length} קבצים ריקים, בלי שורות לקשר: ${empty.slice(0, 5).join(", ")}${empty.length > 5 ? "…" : ""}. בדקו שבחרתם את הקבצים הנכונים.` });
      if (loneCr.length)
        src.info.warnings.push(loneCrWarning(loneCr));
      if (notUtf8.length)
        src.info.warnings.push({
          code: "source/not-utf8",
          message: `${notUtf8.length} קבצים אינם שמורים ב־UTF-8: ${notUtf8.slice(0, 5).join(", ")}${notUtf8.length > 5 ? "…" : ""}. הכלי מציג אותם נכון, אבל אוצריא קוראת כל ספר כ־UTF-8 — שמרו אותם מחדש ב־UTF-8 לפני שליחה לספרייה.`,
        });
      result.sources.push(await this.add(src));
    }
    return result;
  }

  /** Opens a database that needed a mapping (see OpenResult.needsMapping). The token stays valid for a re-map. */
  async openMapped(token: string, mapping: DbMapping, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}): Promise<OpenedSource> {
    const p = this.pending.get(token);
    if (!p) throw new LinkerError("db/mapping-unknown-token", "המסד הזה כבר אינו פתוח לבחירת מיפוי. גררו אותו שוב.");
    // A mapped database is one source like any other (#22): the same file mapped twice is the same reader (the same
    // mapping) or REPLACES it (another mapping), never two readers of one file. The identity is reserved in the same
    // synchronous step that checks it, so two overlapping calls see each other.
    const identity = p.identity;
    const mappingKey = JSON.stringify(mapping);
    const known = identity === undefined ? undefined : this.byIdentity.get(identity);
    const held = known === undefined ? undefined : this.sources.get(known);
    if (held && this.mappingOf.get(held.info.id) === mappingKey) return { info: held.info, books: await held.books() };
    if (held) this.close(held.info.id);
    const id = this.nextId();
    if (identity !== undefined) {
      this.byIdentity.set(identity, id);
      this.identityOf.set(id, identity);
    }
    try {
      const opened = await this.add(await MappedDbSource.open(id, p.label, blobSource(p.blob), mapping, ctx));
      this.mappingOf.set(id, mappingKey);
      return opened;
    } catch (err) {
      if (identity !== undefined && this.byIdentity.get(identity) === id) this.byIdentity.delete(identity);
      this.identityOf.delete(id);
      throw err;
    }
  }

  /** The first lines of the first books through a mapping that is not confirmed yet (the wizard's test). */
  async testMapping(token: string, mapping: DbMapping, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}): Promise<MappingTest> {
    const p = this.pending.get(token);
    if (!p) throw new LinkerError("db/mapping-unknown-token", "המסד הזה כבר אינו פתוח לבחירת מיפוי. גררו אותו שוב.");
    return testMapping(blobSource(p.blob), mapping, ctx);
  }

  async lines(bookKey: string, from: number, to: number): Promise<SourceLine[]> {
    return this.of(bookKey).lines(bookKey, from, to);
  }

  async existingLinks(bookKey: string, from: number, to: number): Promise<Link[]> {
    return this.of(bookKey).existingLinks(bookKey, from, to);
  }

  /** A whole book, chunk by chunk (see BookSource.scan); pages through lines() for a source without scan. */
  async *scan(bookKey: string, chunk: number): AsyncGenerator<LineChunk> {
    const src = this.of(bookKey);
    if (src.scan) return yield* src.scan(bookKey, chunk);
    for (let from = 0; ; from += chunk) {
      const lines = await src.lines(bookKey, from, from + chunk - 1);
      if (lines.length) yield { lines };
      if (!lines.length || lines.at(-1)!.index < from + chunk - 1) return;
    }
  }

  /** The alternative TOC structures the book's source already has (null: the source cannot have any). */
  async altToc(bookKey: string): Promise<LibraryAltTocStructure[] | null> {
    const s = this.of(bookKey);
    return s.altToc ? s.altToc(bookKey) : null;
  }

  /** Every heading line of a book, in order (reads the whole book here, in the worker). */
  async headings(bookKey: string): Promise<BookHeading[]> {
    const out: BookHeading[] = [];
    for (const l of await this.of(bookKey).lines(bookKey, 0, Number.MAX_SAFE_INTEGER))
      if (l.heading !== null) out.push({ line: l.index, level: l.heading, text: stripTags(l.text) });
    return out;
  }

  /** Every open book with its other names, for the citations engine (book_acronym where a source has it). */
  async citationCatalog(): Promise<{ book: SourceBook; aliases: readonly string[] }[]> {
    const out: { book: SourceBook; aliases: readonly string[] }[] = [];
    for (const s of this.sources.values()) {
      const aliases = s.bookAliases ? await s.bookAliases() : new Map<string, readonly string[]>();
      for (const b of await s.books()) out.push({ book: b, aliases: aliases.get(b.key) ?? [] });
    }
    return out;
  }

  /** A book's line references without text, or null when its source has none (text files): use headings. */
  async heRefs(bookKey: string): Promise<{ index: number; heRef: string | null }[] | null> {
    const s = this.of(bookKey);
    return s.heRefs ? s.heRefs(bookKey) : null;
  }

  /** Counts of a book's existing links by type and by the other book, or why it has none (stage 10). */
  async dbLinkSummary(bookKey: string, ctx: ListingContext = {}): Promise<DbLinkSummary | DbLinksUnavailable> {
    const l = await this.listing(bookKey, ctx);
    if (typeof l === "string") return { bookKey, reason: l };
    const books = new Map((await this.of(bookKey).books()).map((b) => [b.key, b]));
    // the other end of a personal database's external_link is a book of another source, or only a title
    for (const k of l.otherBookKeys()) {
      if (books.has(k)) continue;
      if (k.startsWith("unresolved:")) books.set(k, { key: k, title: k.slice("unresolved:".length), origin: "unknown" });
      else {
        const id = sourceIdOfBookKey(k);
        const found = this.sources.has(id) ? (await this.sources.get(id)!.books()).find((b) => b.key === k) : undefined;
        if (found) books.set(k, found);
      }
    }
    return l.summary((k) => ({ title: books.get(k)?.title ?? k, origin: books.get(k)?.origin ?? "unknown" }));
  }

  /** One page of a book's existing links, filtered (stage 10). */
  async dbLinksPage(bookKey: string, query: DbLinkQuery, ctx: ListingContext = {}): Promise<DbLinkPage> {
    const l = await this.listing(bookKey, ctx);
    return typeof l === "string" ? { total: 0, offset: query.offset, links: [] } : l.page(query);
  }

  private async listing(bookKey: string, ctx: ListingContext): Promise<LinkListing | string> {
    const s = this.of(bookKey);
    if (s.linkListing) return s.linkListing(bookKey, ctx);
    if (s.info.kind === "text-files") return "לספרים מקובצי טקסט אין קישורים קיימים במסד. קישורים שלהם נטענים מקובצי ‎_links.json.";
    const p = this.fallbackListings.get(bookKey);
    if (p) {
      // LRU: the book shown again is the last to go
      this.fallbackListings.delete(bookKey);
      this.fallbackListings.set(bookKey, p);
      return p;
    }
    const t0 = performance.now();
    const fresh = s.existingLinks(bookKey, 0, Number.MAX_SAFE_INTEGER).then((links) => listingFromLinks(bookKey, links, Math.round(performance.now() - t0)));
    this.fallbackListings.set(bookKey, fresh);
    fresh.catch(() => this.fallbackListings.get(bookKey) === fresh && this.fallbackListings.delete(bookKey)); // a failed read is not cached
    while (this.fallbackListings.size > FALLBACK_LISTINGS) this.fallbackListings.delete(this.fallbackListings.keys().next().value!);
    return fresh;
  }

  /** The book with this exact title in a source another source's external_link points at (see ExternalTargetResolver). */
  private async findTarget(title: string, targetSource: string | null, from: string, by: "library-id" | "slug" = "library-id"): Promise<TargetBook | null> {
    const candidates = [...this.sources.values()].filter((s) => s.info.id !== from);
    // a database is named by its library_id (external_link), or by the slug Otzaria derives from it (user_link's sourceDb/targetDb)
    const named =
      targetSource === null || targetSource === "official"
        ? []
        : candidates.filter((s) => s instanceof DbBookSource && (by === "slug" ? otzariaSlug(s.capabilities.meta["library_id"], s.info.label) : s.capabilities.meta["library_id"]) === targetSource);
    // 'official' (or none given): the library's own sources, first; a null source then also any other
    const pool = targetSource === "official" ? candidates.filter((s) => s.info.library) : targetSource === null ? [...candidates.filter((s) => s.info.library), ...candidates.filter((s) => !s.info.library)] : named;
    for (const s of pool) {
      const b = (await this.titleIndex(s)).get(title);
      if (b) return { key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }), ...(b.lineCount !== undefined && { lineCount: b.lineCount }) };
    }
    return null;
  }

  private titleIndex(s: BookSource): Promise<Map<string, SourceBook>> {
    let p = this.titleIndexes.get(s.info.id);
    if (!p) {
      p = s.books().then((books) => {
        const m = new Map<string, SourceBook>();
        for (const b of books) if (!m.has(b.title)) m.set(b.title, b);
        return m;
      });
      this.titleIndexes.set(s.info.id, p);
    }
    return p;
  }

  private refIndex(bookKey: string): Promise<Map<string, number>> {
    let p = this.refIndexes.get(bookKey);
    if (!p) {
      const s = this.sources.get(sourceIdOfBookKey(bookKey));
      p = (s?.heRefs ? s.heRefs(bookKey) : Promise.resolve([])).then((rows) => {
        const m = new Map<string, number>();
        for (const r of rows) if (r.heRef && !m.has(r.heRef)) m.set(r.heRef, r.index);
        this.refIndexSizes.set(bookKey, m.size);
        this.trimRefIndexes(bookKey);
        return m;
      });
      this.refIndexes.set(bookKey, p);
      p.catch(() => (this.refIndexes.delete(bookKey), this.refIndexSizes.delete(bookKey)));
    }
    return p;
  }

  /**
   * Keeps the heRef maps within about REF_INDEX_BUDGET entries in all (oldest first, never the one just built):
   * a run resolves the targets of one book at a time, so recent books are the ones needed again.
   */
  private trimRefIndexes(keep: string): void {
    let total = 0;
    for (const n of this.refIndexSizes.values()) total += n;
    for (const k of [...this.refIndexes.keys()]) {
      if (total <= REF_INDEX_BUDGET) break;
      if (k === keep || !this.refIndexSizes.has(k)) continue;
      total -= this.refIndexSizes.get(k)!;
      this.refIndexes.delete(k);
      this.refIndexSizes.delete(k);
    }
  }

  /** a source opened or closed: the databases that resolve external_link targets by title must look again */
  private sourcesChanged(closed?: string): void {
    this.titleIndexes.clear();
    if (closed !== undefined)
      for (const k of [...this.refIndexes.keys()])
        if (sourceIdOfBookKey(k) === closed) {
          this.refIndexes.delete(k);
          this.refIndexSizes.delete(k);
        }
    for (const s of this.sources.values()) if (s instanceof DbBookSource) s.targetsChanged();
  }

  close(sourceId: string): void {
    this.sources.get(sourceId)?.close();
    this.sources.delete(sourceId);
    this.sourcesChanged(sourceId);
    const identity = this.identityOf.get(sourceId);
    if (identity !== undefined) this.byIdentity.delete(identity);
    this.identityOf.delete(sourceId);
    this.mappingOf.delete(sourceId);
    for (const k of [...this.fallbackListings.keys()]) if (sourceIdOfBookKey(k) === sourceId) this.fallbackListings.delete(k);
  }

  private async route(f: InputFile, kind: DetectedKind, result: OpenResult, texts: TextFile[], notUtf8: string[], signal?: AbortSignal, loneCr: string[] = []): Promise<void> {
    switch (kind) {
      case "sqlite":
        try {
          const identity = await fileIdentity(f);
          const known = this.byIdentity.get(identity);
          const held = known ? this.sources.get(known) : undefined;
          if (held) {
            const again = result.reused ?? (result.reused = []);
            if (!again.some((r) => r.info.id === held.info.id)) again.push({ info: held.info, books: await held.books(), ...(nameOf(f.path) !== held.info.label && { as: nameOf(f.path) }) });
            return;
          }
          const fresh = await DbBookSource.open(this.nextId(), nameOf(f.path), blobSource(f.blob));
          // another drop of the same file finished first (drops can overlap): keep that one, release this one
          const raced = this.byIdentity.get(identity);
          const winner = raced ? this.sources.get(raced) : undefined;
          if (winner) {
            fresh.close();
            (result.reused ??= []).push({ info: winner.info, books: await winner.books() });
            return;
          }
          // the identity is taken in the same synchronous step that registers the source (add sets it before it awaits),
          // so a drop of the same file finishing in the meantime sees it
          this.byIdentity.set(identity, fresh.info.id);
          this.identityOf.set(fresh.info.id, identity);
          const opened = await this.add(fresh);
          result.sources.push(opened);
        } catch (err) {
          // not Otzaria's schema: hand its tables to the mapping wizard instead of refusing the file
          if (err instanceof LinkerError && err.code === "db/no-books") return this.offerMapping(f, result);
          result.skipped.push({ path: f.path, reason: reasonOf(err, "לא הצלחתי לקרוא את המסד.") });
        }
        return;
      case "zip":
        return this.openZip(f, result, signal);
      case "links-json":
      case "alt-toc-json":
      case "project":
        if (f.blob.size > MAX_TEXT_DOC) return void result.skipped.push({ path: f.path, reason: "הקובץ גדול מדי לייבוא (מעל 256MB)." });
        result.documents.push({ path: f.path, kind, text: documentText(new Uint8Array(await f.blob.arrayBuffer())) });
        return;
      case "text":
        if (/\.txt$/i.test(f.path) || !/\.[a-z0-9]{1,5}$/i.test(f.path)) {
          texts.push({ path: f.path, read: async () => new Uint8Array(await f.blob.arrayBuffer()) });
          const head = new Uint8Array(await f.blob.slice(0, SNIFF).arrayBuffer());
          const enc = decodeText(head, { partial: f.blob.size > SNIFF }).encoding;
          if (hasLoneCr(head, f.blob.size > SNIFF)) loneCr.push(f.path);
          if (enc !== "utf-8") notUtf8.push(`${f.path} (${enc})`);
        } else result.skipped.push({ path: f.path, reason: "קובץ טקסט שאינו ‎.txt — לא נטען כספר." });
        return;
      case "json":
        // other JSON (an array of records, an object holding one, JSON Lines): the user maps its fields
        if (f.blob.size > MAX_TEXT_DOC) return void result.skipped.push({ path: f.path, reason: "הקובץ גדול מדי לייבוא (מעל 256MB)." });
        {
          const text = decodeText(new Uint8Array(await f.blob.arrayBuffer())).text;
          if (!parseRecords(text, f.path)) return void result.skipped.push({ path: f.path, reason: "קובץ JSON שאין בו רשומות קישורים (מערך של אובייקטים, אובייקט שמכיל מערך כזה, או JSON Lines)." });
          result.documents.push({ path: f.path, kind: "records", text });
        }
        return;
      case "csv":
      case "tsv":
        if (f.blob.size > MAX_TEXT_DOC) return void result.skipped.push({ path: f.path, reason: "הקובץ גדול מדי לייבוא (מעל 256MB)." });
        result.documents.push({ path: f.path, kind: "links-csv", text: decodeText(new Uint8Array(await f.blob.arrayBuffer())).text });
        return;
      case "zstd-dict": {
        if (f.blob.size > 2 * 1024 ** 2) return void result.skipped.push({ path: f.path, reason: "קובץ מילון דחיסה גדול מ־2MB: מפענח הדפדפן אינו תומך בו." });
        try {
          const id = sharedDictionaries.add(new Uint8Array(await f.blob.arrayBuffer()), f.path);
          if (id === null) return void result.skipped.push({ path: f.path, reason: "הקובץ נראה כמו מילון דחיסה, אבל אין לו מזהה." });
          (result.dictionaries ??= []).push({ path: f.path, id });
        } catch (err) {
          result.skipped.push({ path: f.path, reason: reasonOf(err, "לא הצלחתי לקרוא את מילון הדחיסה.") });
        }
        return;
      }
      case "binary":
        return void result.skipped.push({ path: f.path, reason: "קובץ בינארי שאינו מסד SQLite או ZIP." });
    }
  }

  private async offerMapping(f: InputFile, result: OpenResult): Promise<void> {
    try {
      const offered = await pendingMapping(f.path, nameOf(f.path), f.blob, this.pending);
      (result.needsMapping ??= []).push(offered);
      // the identity of the file, kept with its token: when it is mapped, picking it again is "already open" (like an Otzaria database)
      const entry = this.pending.get(offered.token);
      if (entry) entry.identity = await fileIdentity(f);
    } catch (err) {
      result.skipped.push({ path: f.path, reason: reasonOf(err, "לא הצלחתי לקרוא את המסד.") });
    }
  }

  private async openZip(f: InputFile, result: OpenResult, signal?: AbortSignal): Promise<void> {
    if (f.blob.size > MAX_ZIP)
      return void result.skipped.push({ path: f.path, reason: "הארכיון גדול מ־512MB, ולכן לא נפתח בדפדפן. חלצו אותו במחשב ובחרו את התיקייה." });
    let entries;
    try {
      const bytes = new Uint8Array(await f.blob.arrayBuffer());
      entries = safeUnzip(bytes, { include: (p) => /\.(txt|json)$/i.test(p), ...(signal && { signal }) });
    } catch (err) {
      // a cancel stops the whole open (as between files in open()), it is not a reason to skip this one
      if (signal?.aborted) throw err;
      return void result.skipped.push({ path: f.path, reason: reasonOf(err, "הארכיון פגום או חשוד.") });
    }
    if (!entries.length)
      return void result.skipped.push({ path: f.path, reason: "בארכיון אין ספרים (‎.txt) או קובצי קישורים — או שהוא פגום." });
    const texts: TextFile[] = [];
    for (const e of entries) {
      const path = `${nameOf(f.path)}/${e.path}`;
      const kind = detectKind(e.bytes.subarray(0, HEAD), e.path);
      if (kind === "links-json" || kind === "alt-toc-json" || kind === "project") result.documents.push({ path, kind, text: documentText(e.bytes) });
      else if (kind === "text" && /\.txt$/i.test(e.path)) texts.push({ path: e.path, read: async () => e.bytes });
      else result.skipped.push({ path, reason: "קובץ בתוך הארכיון שאינו ספר ‎.txt או קובץ קישורים." });
    }
    if (texts.length) result.sources.push(await this.add(new TextFilesSource(this.nextId(), nameOf(f.path), texts)));
  }

  private async add(s: BookSource): Promise<OpenedSource> {
    this.sources.set(s.info.id, s);
    if (s instanceof DbBookSource) s.setTargetResolver(this.resolver);
    this.sourcesChanged();
    return { info: s.info, books: await s.books() };
  }

  private of(bookKey: string): BookSource {
    const s = this.sources.get(sourceIdOfBookKey(bookKey));
    if (!s) throw new LinkerError("source/closed", "המקור של הספר הזה כבר נסגר.");
    return s;
  }

  /**
   * The prefix of the ids this registry gives its sources (default "s": s1, s2…). The worker host gives
   * each worker its own, so ids never repeat after a restart (app/worker-host.ts, review C2).
   */
  useIdPrefix(prefix: string): void {
    if (!/^[\w.-]+$/.test(prefix)) throw new Error(`bad source id prefix "${prefix}"`); // never ":" (the key separator)
    this.idPrefix = prefix;
  }

  private nextId(): string {
    return `${this.idPrefix}${++this.seq}`;
  }
}

type ListingContext = { signal?: AbortSignal; progress?: (done: number, total: number) => void };

/**
 * The identity of a database file by its CONTENT (V7 §1.6, #42 C29) — see SourceRegistry.byIdentity. It used to be the
 * name, size, last-modified time and header: a byte-identical copy under another name loaded as a second source, and a
 * file changed only in its middle with the same counter passed as the same one. Now: size | the 100-byte SQLite header
 * (change counter, pages, schema cookie) | SHA-256 of three 64 KiB samples (start, middle, end). Staged, not a full hash:
 * a 5 GB database is identified in milliseconds; two files that agree on all of this are copies of one database.
 */
const SAMPLE = 64 * 1024;
async function fileIdentity(f: InputFile): Promise<string> {
  const size = f.blob.size;
  const head = new Uint8Array(await f.blob.slice(0, 100).arrayBuffer());
  const hex = Array.from(head, (b) => b.toString(16).padStart(2, "0")).join("");
  const mid = Math.max(0, Math.floor(size / 2) - SAMPLE / 2);
  const parts = await Promise.all([f.blob.slice(0, SAMPLE), f.blob.slice(mid, mid + SAMPLE), f.blob.slice(Math.max(0, size - SAMPLE))].map(async (b) => new Uint8Array(await b.arrayBuffer())));
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) joined.set(p, at), (at += p.length);
  return `${size}|${hex}|${sha256Hex(joined)}`;
}

/** A CR byte not followed by LF (a lone CR, #41 B10); the last byte of a cut head is not judged. */
function hasLoneCr(bytes: Uint8Array, partial: boolean): boolean {
  const end = partial ? bytes.length - 1 : bytes.length;
  for (let i = 0; i < end; i++) if (bytes[i] === 13 && bytes[i + 1] !== 10) return true;
  return false;
}

/** The warning of TextFilesSource (text-source.ts loneCrMessage), for the files the open found. */
function loneCrWarning(paths: readonly string[]): { code: string; message: string } {
  return { code: "source/lone-cr", message: loneCrMessage(paths) };
}

const nameOf = (path: string): string => path.split(/[\\/]/).at(-1) ?? path;

function labelForTexts(files: readonly TextFile[]): string {
  const roots = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0]! : "")));
  if (roots.size === 1 && !roots.has("")) return [...roots][0]!;
  return files.length === 1 ? nameOf(files[0]!.path) : `${files.length} קובצי טקסט`;
}

/**
 * A links/project document as text. A UTF-8 BOM is kept (as U+FEFF) so the links-file parser can warn
 * about it: the weekly library sync rejects such a file (validation: the warning never reached the user).
 */
function documentText(bytes: Uint8Array): string {
  const d = decodeText(bytes);
  return d.hadBom && d.encoding === "utf-8" ? String.fromCharCode(0xfeff) + d.text : d.text;
}

function reasonOf(err: unknown, fallback: string): string {
  return err instanceof LinkerError ? err.message : `${fallback} (${err instanceof Error ? err.message : String(err)})`;
}
