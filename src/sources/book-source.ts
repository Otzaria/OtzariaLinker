import type { SourceBook, SourceInfo, SourceLine } from "../core/books";
import type { Link } from "../core/links/model";

export type { SourceBook, SourceInfo, SourceKind, SourceLine } from "../core/books";

/*
 * One interface for every place books come from (stage 6): an Otzaria database, loose .txt files,
 * a folder, a ZIP… The UI and the engines see only this. Implementations live in the worker.
 */
export interface BookSource {
  readonly info: SourceInfo;
  books(): Promise<SourceBook[]>;
  lines(bookKey: string, from?: number, to?: number): Promise<SourceLine[]>;
  /** existing links touching lines [from, to] of a book (read-only, provenance "db") */
  existingLinks(bookKey: string, from: number, to: number): Promise<Link[]>;
  close(): void;
}
