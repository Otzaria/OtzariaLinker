import type { LibraryAltTocStructure } from "../core/alt-toc/model";
import type { BookHeading, SourceLine } from "../core/books";
import type { DbMapping, MappingTest } from "../core/db-mapping";
import type { CoverageEnds } from "../core/links/coverage-ends";
import type { LinkMatchList } from "../core/links/equality";
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
import type { TitleFitReport } from "../linking/title-fit";

/** The worker's operations, as the UI calls them through RpcClient. */
export interface SourcesApi {
  [op: string]: (...args: never[]) => unknown;
  /** the self-check (self-check.ts): what the lazy SQLite reader and the zstd decoder read from tiny probes */
  ping(): { sqlite: string; zstd: string };
  /** the host's prefix for the ids of the sources this worker opens (the worker's first call: app/worker-host.ts) */
  init(idPrefix: string): void;
  open(files: InputFile[]): OpenResult;
  /** opens a database from OpenResult.needsMapping through the user's mapping (may scan: progress, cancel) */
  openMapped(token: string, mapping: DbMapping): OpenedSource;
  /** the first lines of the first books through a mapping, before it is confirmed (bounded read) */
  testMapping(token: string, mapping: DbMapping): MappingTest;
  lines(bookKey: string, from: number, to: number): SourceLine[];
  existingLinks(bookKey: string, from: number, to: number): Link[];
  /** for each run [from, to] of a book's lines, the match index of its existing links: identities only, many runs in one call (V7 round 2 item 11) */
  existingMatchIndexes(bookKey: string, runs: [number, number][]): LinkMatchList[];
  /** a book's existing links, compact, as the coverage rules read them (#42 C7, C8); stops on a cancel */
  coverageEnds(bookKey: string): CoverageEnds;
  close(sourceId: string): void;
  /** runs an automatic engine on two whole books (both read here, in the worker) */
  runEngine(engine: EngineId, source: BookRef, target: BookRef, options: Record<string, unknown>): EngineResult;
  /** does the commentary's titles fit its base (the headings method)? verdict and reasons, before any run */
  titleFit(source: BookRef, target: BookRef): TitleFitReport;
  diffBooks(oldKey: string, newKey: string): BookDiff;
  runBatch(engine: EngineId, pairs: { source: BookRef; target: BookRef }[], options: Record<string, unknown>): BatchItem[];
  /** lines of one book that contain a query (capped), with snippets; progress counts lines */
  searchBook(bookKey: string, query: string, options: SearchOptions): BookSearchResult;
  altToc(bookKey: string): LibraryAltTocStructure[] | null;
  headings(bookKey: string): BookHeading[];
  /** the citations engine on one book: its references, linked into every open book (progress in per-mille) */
  runCitations(source: BookRef, options: Record<string, unknown>): EngineResult;
  /** counts of a book's existing (database) links by type and other book; progress counts links read */
  dbLinkSummary(bookKey: string): DbLinkSummary | DbLinksUnavailable;
  /** one filtered page of a book's existing links */
  dbLinksPage(bookKey: string, query: DbLinkQuery): DbLinkPage;
  /** runs a max-link plan's steps (progress over all steps; one pair in memory at a time) */
  runMaxLink(steps: PlanStep[], options: MaxLinkJobOptions): MaxLinkJobResult;
  /** the fingerprints of books' text, by key (an unreadable book is left out); progress counts books */
  fingerprints(bookKeys: string[]): Record<string, string>;
}
