import type { LibraryAltTocStructure } from "../core/alt-toc/model";
import type { BookHeading, SourceBook, SourceInfo, SourceLine } from "../core/books";
import type { DbMapping, PendingDb } from "../core/db-mapping";
import type { BookRef, Link } from "../core/links/model";
import type { DbLinkPage, DbLinkQuery, DbLinkSummary, DbLinksUnavailable } from "../core/links/db-links";
import type { EngineId, EngineResult } from "../linking/automatic";
import type { LineFate } from "../matching/line-diff";
import type { BookSearchResult } from "../core/text/find";

/*
 * What the state layer needs from the outside world, as interfaces (architecture rule 17). The app
 * wires the real worker client in; tests pass an in-memory fake. Shapes match src/sources/registry
 * structurally, without importing it (state may not depend on sources).
 */
export interface InputFile {
  path: string;
  blob: Blob;
}

export interface OpenedSource {
  info: SourceInfo;
  books: SourceBook[];
}

export interface OpenResult {
  sources: OpenedSource[];
  documents: { path: string; kind: "links-json" | "links-csv" | "alt-toc-json" | "project"; text: string }[];
  skipped: { path: string; reason: string }[];
  /** SQLite files not in Otzaria's schema, waiting for the mapping wizard */
  needsMapping?: PendingDb[];
}

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface BooksService {
  open(files: InputFile[], opts?: CallOptions): Promise<OpenResult>;
  openMapped(token: string, mapping: DbMapping, opts?: CallOptions): Promise<OpenedSource>;
  lines(bookKey: string, from: number, to: number, opts?: CallOptions): Promise<SourceLine[]>;
  existingLinks(bookKey: string, from: number, to: number, opts?: CallOptions): Promise<Link[]>;
  close(sourceId: string): Promise<void>;
  runEngine(engine: EngineId, source: BookRef, target: BookRef, options: Record<string, unknown>, opts?: CallOptions): Promise<EngineResult>;
  diffBooks(oldKey: string, newKey: string, opts?: CallOptions): Promise<{ to: number[]; fate: LineFate[]; stats: Record<string, number> }>;
  runBatch(engine: EngineId, pairs: { source: BookRef; target: BookRef }[], options: Record<string, unknown>, opts?: CallOptions): Promise<BatchResultItem[]>;
  searchBook(bookKey: string, query: string, options: { limit?: number }, opts?: CallOptions): Promise<BookSearchResult>;
  /** alt_toc structures the book's database already has (null: its source cannot have any) */
  altToc(bookKey: string, opts?: CallOptions): Promise<LibraryAltTocStructure[] | null>;
  /** every heading line of a book, in order */
  headings(bookKey: string, opts?: CallOptions): Promise<BookHeading[]>;
  /**
   * A book's existing database links, counted and paged (stage 10). Optional so that test fakes
   * without databases need not implement it; the links panel then says the list is unavailable.
   */
  dbLinkSummary?(bookKey: string, opts?: CallOptions): Promise<DbLinkSummary | DbLinksUnavailable>;
  dbLinksPage?(bookKey: string, query: DbLinkQuery, opts?: CallOptions): Promise<DbLinkPage>;
}

/** One pair of a batch run (mirrors workers/engine-job BatchItem). */
export interface BatchResultItem {
  source: BookRef;
  target: BookRef;
  result?: EngineResult;
  error?: string;
}

/** Where a file the program makes goes (a download in the browser). */
export interface Saver {
  save(name: string, data: Uint8Array | string, mime: string): void;
}

/** Small persistent storage for autosave (IndexedDB in the browser). Every call may fail; callers cope. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
