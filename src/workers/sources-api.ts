import type { LibraryAltTocStructure } from "../core/alt-toc/model";
import type { BookHeading, SourceLine } from "../core/books";
import type { DbMapping } from "../core/db-mapping";
import type { BookRef, Link } from "../core/links/model";
import type { DbLinkPage, DbLinkQuery, DbLinkSummary, DbLinksUnavailable } from "../core/links/db-links";
import type { EngineId, EngineResult } from "../linking/automatic";
import type { InputFile, OpenedSource, OpenResult } from "../sources/registry";
import type { BatchItem, BookDiff } from "./engine-job";
import type { BookSearchResult } from "../core/text/find";
import type { SearchOptions } from "./search-job";
import type { MaxLinkJobResult } from "../linking/maxlink-report";
import type { PlanStep } from "../linking/plan";
import type { MaxLinkJobOptions } from "./maxlink-job";

/** The worker's operations, as the UI calls them through RpcClient. */
export interface SourcesApi {
  [op: string]: (...args: never[]) => unknown;
  /** proves sql.js and the zstd WASM start in this environment (file://, CSP) */
  ping(): { sqlite: string; zstd: string };
  /** cheap liveness probe for the watchdog */
  alive(): true;
  open(files: InputFile[]): OpenResult;
  /** opens a database from OpenResult.needsMapping through the user's mapping (may scan: progress, cancel) */
  openMapped(token: string, mapping: DbMapping): OpenedSource;
  lines(bookKey: string, from: number, to: number): SourceLine[];
  existingLinks(bookKey: string, from: number, to: number): Link[];
  close(sourceId: string): void;
  /** runs an automatic engine on two whole books (both read here, in the worker) */
  runEngine(engine: EngineId, source: BookRef, target: BookRef, options: Record<string, unknown>): EngineResult;
  diffBooks(oldKey: string, newKey: string): BookDiff;
  runBatch(engine: EngineId, pairs: { source: BookRef; target: BookRef }[], options: Record<string, unknown>): BatchItem[];
  /** lines of one book that contain a query (capped), with snippets; progress counts lines */
  searchBook(bookKey: string, query: string, options: SearchOptions): BookSearchResult;
  altToc(bookKey: string): LibraryAltTocStructure[] | null;
  headings(bookKey: string): BookHeading[];
  /** counts of a book's existing (database) links by type and other book; progress counts links read */
  dbLinkSummary(bookKey: string): DbLinkSummary | DbLinksUnavailable;
  /** one filtered page of a book's existing links */
  dbLinksPage(bookKey: string, query: DbLinkQuery): DbLinkPage;
  /** runs a max-link plan's steps (progress over all steps; one pair in memory at a time) */
  runMaxLink(steps: PlanStep[], options: MaxLinkJobOptions): MaxLinkJobResult;
}
