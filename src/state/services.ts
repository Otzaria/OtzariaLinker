import type { LibraryAltTocStructure } from "../core/alt-toc/model";
import type { BookHeading, SourceBook, SourceInfo, SourceLine } from "../core/books";
import type { DbMapping, MappingTest, PendingDb } from "../core/db-mapping";
import type { CoverageEnds } from "../core/links/coverage-ends";
import type { LinkMatchList } from "../core/links/equality";
import type { BookRef, Link } from "../core/links/model";
import type { DbLinkPage, DbLinkQuery, DbLinkSummary, DbLinksUnavailable } from "../core/links/db-links";
import type { EngineId, EngineResult, SourceFilter } from "../linking/automatic";
import type { LineFate } from "../matching/line-diff";
import type { BookSearchResult } from "../core/text/find";
import type { MaxLinkJobResult } from "../linking/maxlink-report";
import type { PlanStep } from "../linking/plan";
import type { TitleFitReport } from "../linking/title-fit";

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
  documents: { path: string; kind: "links-json" | "links-csv" | "alt-toc-json" | "project" | "records"; text: string }[];
  skipped: { path: string; reason: string }[];
  /** SQLite files not in Otzaria's schema, waiting for the mapping wizard */
  needsMapping?: PendingDb[];
  /** zstd dictionaries opened as files (books compressed with them become readable) */
  dictionaries?: { path: string; id: number }[];
  /** databases already open: the same file picked again is not opened a second time (#22) */
  /** already open; `as` = the name the file was picked under, when it is not the open source's (a copy, #42 C29) */
  reused?: (OpenedSource & { as?: string })[];
}

export interface CallOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** a cancel waits for what the call found so far instead of rejecting (workers/rpc.ts CallOptions.keepPartial) */
  keepPartial?: boolean;
}

export interface BooksService {
  open(files: InputFile[], opts?: CallOptions): Promise<OpenResult>;
  openMapped(token: string, mapping: DbMapping, opts?: CallOptions): Promise<OpenedSource>;
  /** the wizard's "test the mapping": first lines of the first books (optional for test fakes) */
  testMapping?(token: string, mapping: DbMapping, opts?: CallOptions): Promise<MappingTest>;
  lines(bookKey: string, from: number, to: number, opts?: CallOptions): Promise<SourceLine[]>;
  existingLinks(bookKey: string, from: number, to: number, opts?: CallOptions): Promise<Link[]>;
  /**
   * For each run [from, to] of a book's lines, the match index (core/links/equality.ts) of existingLinks(bookKey, from, to): many runs
   * in one call, and only the identities (V7 round 2 item 11). Optional for test fakes: the check then reads existingLinks() run by run.
   */
  existingMatchIndexes?(bookKey: string, runs: [number, number][], opts?: CallOptions): Promise<LinkMatchList[]>;
  /**
   * A book's existing links as the coverage rules read them (core/links/coverage-ends.ts, #42 C7, C8): a few typed arrays
   * instead of a Link per row. Optional for test fakes: coverage then reads existingLinks() over the whole book.
   */
  coverageEnds?(bookKey: string, opts?: CallOptions): Promise<CoverageEnds>;
  close(sourceId: string): Promise<void>;
  runEngine(engine: EngineId, source: BookRef, target: BookRef, options: Record<string, unknown>, opts?: CallOptions): Promise<EngineResult>;
  /** Whether a commentary's titles fit its base (linking/title-fit.ts). Optional like runMaxLink: test fakes need not implement it. */
  titleFit?(source: BookRef, target: BookRef, opts?: CallOptions): Promise<TitleFitReport>;
  diffBooks(oldKey: string, newKey: string, opts?: CallOptions): Promise<{ to: number[]; fate: LineFate[]; similarity: number[]; moves: [number, number][]; newLength: number; stats: Record<string, number> }>;
  runBatch(engine: EngineId, pairs: { source: BookRef; target: BookRef }[], options: Record<string, unknown>, opts?: CallOptions): Promise<BatchResultItem[]>;
  searchBook(bookKey: string, query: string, options: { limit?: number }, opts?: CallOptions): Promise<BookSearchResult>;
  /** alt_toc structures the book's database already has (null: its source cannot have any) */
  altToc(bookKey: string, opts?: CallOptions): Promise<LibraryAltTocStructure[] | null>;
  /** every heading line of a book, in order */
  headings(bookKey: string, opts?: CallOptions): Promise<BookHeading[]>;
  /** the citations engine (single book): references in one book, linked into all open books */
  runCitations(source: BookRef, options: Record<string, unknown>, opts?: CallOptions): Promise<EngineResult>;
  /**
   * A book's existing database links, counted and paged (stage 10). Optional so that test fakes
   * without databases need not implement it; the links panel then says the list is unavailable.
   */
  dbLinkSummary?(bookKey: string, opts?: CallOptions): Promise<DbLinkSummary | DbLinksUnavailable>;
  dbLinksPage?(bookKey: string, query: DbLinkQuery, opts?: CallOptions): Promise<DbLinkPage>;
  /**
   * Runs the steps of a max-link plan in the worker (workers/maxlink-job.ts). Optional so that
   * services without it (older test fakes) still type-check; max-link then reports it is unavailable.
   */
  runMaxLink?(steps: PlanStep[], options: { engineOptions?: Partial<Record<string, Record<string, unknown>>>; sefariaOwned?: readonly string[]; sourceFilter?: SourceFilter }, opts?: CallOptions): Promise<MaxLinkJobResult>;
  /** The fingerprints of books' text (core/text/fingerprint.ts), by key: the batch job skips unchanged books by them. Optional like runMaxLink. */
  fingerprints?(bookKeys: string[], opts?: CallOptions): Promise<Record<string, string>>;
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
  /** every key (optional: the autosave then cannot find what other windows left behind) */
  keys?(): Promise<string[]>;
}
