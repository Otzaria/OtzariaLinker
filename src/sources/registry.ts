import type { LibraryAltTocStructure } from "../core/alt-toc/model";
import type { BookHeading, SourceBook, SourceInfo, SourceLine } from "../core/books";
import type { DbMapping, PendingDb } from "../core/db-mapping";
import { sourceIdOfBookKey } from "../core/books";
import { LinkerError } from "../core/errors";
import type { Link } from "../core/links/model";
import type { DbLinkPage, DbLinkQuery, DbLinkSummary, DbLinksUnavailable } from "../core/links/db-links";
import { decodeText } from "../core/text/decode";
import { SEFARIA_TITLES_PATH } from "../core/links/sefaria-owned";
import { parseRecords } from "../formats/records/records";
import { stripTags } from "../core/text/html";
import { sharedDictionaries } from "../database/compression/zstd";
import { blobSource } from "../database/sqlite/lazy/byte-source";
import { safeUnzip } from "./archives/safe-unzip";
import type { BookSource, LineChunk } from "./book-source";
import { DbBookSource } from "./db/db-source";
import { MappedDbSource } from "./db/mapped-source";
import { pendingMapping } from "./db/pending";
import { listingFromLinks, type LinkListing } from "./db/link-listing";
import { detectKind, type DetectedKind } from "./detect";
import { TextFilesSource, type TextFile } from "./text/text-source";

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
}

const HEAD = 4096;
const MAX_TEXT_DOC = 256 * 1024 ** 2;
/** a ZIP is read whole into memory to be inflated, so its size is capped first */
const MAX_ZIP = 512 * 1024 ** 2;

export class SourceRegistry {
  private readonly sources = new Map<string, BookSource>();
  /** databases waiting for (or opened with) a mapping, by token — a few File handles, no data */
  private readonly pending = new Map<string, { blob: Blob; label: string }>();
  private seq = 0;
  /** listings built from existingLinks() for sources without their own (mapped databases), by book key */
  private readonly fallbackListings = new Map<string, Promise<LinkListing>>();

  async open(files: readonly InputFile[], signal?: AbortSignal): Promise<OpenResult> {
    const result: OpenResult = { sources: [], documents: [], skipped: [] };
    const texts: TextFile[] = [];
    const notUtf8: string[] = [];
    for (const f of files) {
      signal?.throwIfAborted();
      const kind = detectKind(new Uint8Array(await f.blob.slice(0, HEAD).arrayBuffer()), f.path);
      await this.route(f, kind, result, texts, notUtf8);
    }
    if (texts.length) {
      const src = new TextFilesSource(this.nextId(), labelForTexts(texts), texts);
      // a checkout of the library carries its list of Sefaria titles: its books are the library's (sefaria-titles.ts)
      if (files.some((f) => f.path.replace(/\\/g, "/").endsWith(SEFARIA_TITLES_PATH))) src.info.library = true;
      // decided at open time: a warning added on first read (inside the source) never reached the UI
      if (notUtf8.length)
        src.info.warnings.push({
          code: "source/not-utf8",
          message: `${notUtf8.length} קבצים אינם שמורים ב־UTF-8: ${notUtf8.slice(0, 5).join(", ")}${notUtf8.length > 5 ? "…" : ""}. הכלי מציג אותם נכון, אבל הגנרטור של אוצריא קורא כל ספר כ־UTF-8 — שמרו אותם מחדש ב־UTF-8 לפני שליחה לספרייה.`,
        });
      result.sources.push(await this.add(src));
    }
    return result;
  }

  /** Opens a database that needed a mapping (see OpenResult.needsMapping). The token stays valid for a re-map. */
  async openMapped(token: string, mapping: DbMapping, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}): Promise<OpenedSource> {
    const p = this.pending.get(token);
    if (!p) throw new LinkerError("db/mapping-unknown-token", "המסד הזה כבר אינו פתוח לבחירת מיפוי. גררו אותו שוב.");
    return this.add(await MappedDbSource.open(this.nextId(), p.label, blobSource(p.blob), mapping, ctx));
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
    let p = this.fallbackListings.get(bookKey);
    if (!p) {
      const t0 = performance.now();
      p = s.existingLinks(bookKey, 0, Number.MAX_SAFE_INTEGER).then((links) => listingFromLinks(bookKey, links, Math.round(performance.now() - t0)));
      this.fallbackListings.set(bookKey, p);
      p.catch(() => this.fallbackListings.delete(bookKey));
    }
    return p;
  }

  close(sourceId: string): void {
    this.sources.get(sourceId)?.close();
    this.sources.delete(sourceId);
    for (const k of [...this.fallbackListings.keys()]) if (sourceIdOfBookKey(k) === sourceId) this.fallbackListings.delete(k);
  }

  private async route(f: InputFile, kind: DetectedKind, result: OpenResult, texts: TextFile[], notUtf8: string[]): Promise<void> {
    switch (kind) {
      case "sqlite":
        try {
          result.sources.push(await this.add(await DbBookSource.open(this.nextId(), nameOf(f.path), blobSource(f.blob))));
        } catch (err) {
          // not Otzaria's schema: hand its tables to the mapping wizard instead of refusing the file
          if (err instanceof LinkerError && err.code === "db/no-books") return this.offerMapping(f, result);
          result.skipped.push({ path: f.path, reason: reasonOf(err, "לא הצלחתי לקרוא את המסד.") });
        }
        return;
      case "zip":
        return this.openZip(f, result);
      case "links-json":
      case "alt-toc-json":
      case "project":
        if (f.blob.size > MAX_TEXT_DOC) return void result.skipped.push({ path: f.path, reason: "הקובץ גדול מדי לייבוא (מעל 256MB)." });
        result.documents.push({ path: f.path, kind, text: documentText(new Uint8Array(await f.blob.arrayBuffer())) });
        return;
      case "text":
        if (/\.txt$/i.test(f.path) || !/\.[a-z0-9]{1,5}$/i.test(f.path)) {
          texts.push({ path: f.path, read: async () => new Uint8Array(await f.blob.arrayBuffer()) });
          const enc = decodeText(new Uint8Array(await f.blob.slice(0, 64 * 1024).arrayBuffer())).encoding;
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
      (result.needsMapping ??= []).push(await pendingMapping(f.path, nameOf(f.path), f.blob, this.pending));
    } catch (err) {
      result.skipped.push({ path: f.path, reason: reasonOf(err, "לא הצלחתי לקרוא את המסד.") });
    }
  }

  private async openZip(f: InputFile, result: OpenResult): Promise<void> {
    if (f.blob.size > MAX_ZIP)
      return void result.skipped.push({ path: f.path, reason: "הארכיון גדול מ־512MB, ולכן לא נפתח בדפדפן. חלצו אותו במחשב ובחרו את התיקייה." });
    let entries;
    try {
      entries = safeUnzip(new Uint8Array(await f.blob.arrayBuffer()), { include: (p) => /\.(txt|json)$/i.test(p) });
    } catch (err) {
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
    return { info: s.info, books: await s.books() };
  }

  private of(bookKey: string): BookSource {
    const s = this.sources.get(sourceIdOfBookKey(bookKey));
    if (!s) throw new LinkerError("source/closed", "המקור של הספר הזה כבר נסגר.");
    return s;
  }

  private nextId(): string {
    return `s${++this.seq}`;
  }
}

type ListingContext = { signal?: AbortSignal; progress?: (done: number, total: number) => void };

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
