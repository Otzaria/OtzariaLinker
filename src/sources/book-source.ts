import type { LibraryAltTocStructure } from "../core/alt-toc/model";
import type { SourceBook, SourceInfo, SourceLine } from "../core/books";
import type { Link } from "../core/links/model";

export type { SourceBook, SourceInfo, SourceKind, SourceLine } from "../core/books";

/*
 * One interface for every place books come from (stage 6): an Otzaria database, loose .txt files,
 * a folder, a ZIP… The UI and the engines see only this. Implementations live in the worker.
 */
/** Consecutive lines of a book, and the book's line count when the source knows it. */
export interface LineChunk {
  lines: SourceLine[];
  total?: number;
}

export interface BookSource {
  readonly info: SourceInfo;
  books(): Promise<SourceBook[]>;
  lines(bookKey: string, from?: number, to?: number): Promise<SourceLine[]>;
  /** existing links touching lines [from, to] of a book (read-only, provenance "db") */
  existingLinks(bookKey: string, from: number, to: number): Promise<Link[]>;
  /**
   * The whole book, chunk by chunk, for a scan (in-book search). Optional: without it the registry
   * pages through lines(); a source implements it when it can read a whole book more cheaply.
   */
  scan?(bookKey: string, chunk: number): AsyncIterable<LineChunk>;
  /** alternative TOC structures the source already has for a book; null = the source cannot have any */
  altToc?(bookKey: string): Promise<LibraryAltTocStructure[] | null>;
  close(): void;
}
