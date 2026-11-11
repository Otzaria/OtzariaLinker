import type { BookOrigin, Link } from "../core/links/model";

/*
 * One interface for every place books come from (stage 6): an Otzaria database, loose .txt files,
 * a folder, a ZIP… The UI and the engines see only this. Implementations live in the worker.
 */
export type SourceKind = "otzaria-db" | "text-files";

export interface SourceBook {
  /** unique across all open sources: "<sourceId>:<book id inside the source>" */
  key: string;
  /** exact title as the generator/database knows it (what path_2 and the links file name carry) */
  title: string;
  origin: BookOrigin;
  isBaseBook?: boolean;
  /** known up front for databases; for text files after the first read */
  lineCount?: number;
  /** relative path inside a folder/ZIP, for display and for telling same-named books apart */
  path?: string;
  /** e.g. "Sefaria", "MoreBooks" — the database's source name */
  sourceName?: string;
}

export interface SourceLine {
  /** 0-based */
  index: number;
  /** the line as stored — what the user sees (after sanitizing) */
  text: string;
  /** the exact string the generator counts anchor offsets on (schema 7: with footnote bodies) */
  anchorText: string;
  heRef: string | null;
  /** 1–6 when the generator treats the line as a heading (links to it are dropped) */
  heading: number | null;
  /** false for a line the generator never creates (a heading with empty text): links to it are dropped */
  existsInDb: boolean;
}

export interface SourceInfo {
  id: string;
  kind: SourceKind;
  label: string;
  warnings: { code: string; message: string }[];
}

export interface BookSource {
  readonly info: SourceInfo;
  books(): Promise<SourceBook[]>;
  lines(bookKey: string, from?: number, to?: number): Promise<SourceLine[]>;
  /** existing links touching lines [from, to] of a book (read-only, provenance "db") */
  existingLinks(bookKey: string, from: number, to: number): Promise<Link[]>;
  close(): void;
}
