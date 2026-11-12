import type { BookOrigin } from "./links/model";

/*
 * Plain data about books and lines as every source reports them (stage 6). They live in core so
 * that the state and UI layers can hold them without depending on any source implementation.
 */
export type SourceKind = "otzaria-db" | "text-files" | "mapped-db";

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
  /**
   * Keys of the books this one is written on, as the source declares them (Otzaria databases from
   * schema 2: book_base_text). Absent when the source does not say; the max-link planner then falls
   * back to the title ("X על Y").
   */
  bases?: string[];
  /** book.dependenceType as stored: "commentary", "targum", "midrash", "guides" (schema 2+) */
  dependence?: string;
  /**
   * Keys of books the source's own data shows this one is a commentary on, without declaring it a
   * base (Otzaria databases: default_commentator). Evidence for the max-link planner (linking/plan.ts).
   */
  linkedBases?: string[];
  /**
   * book_has_links.hasSourceLinks of an Otzaria database: the book has links of its own in the
   * database, so the library may hold a links file for it (the export then asks for that file).
   */
  hasSourceLinks?: boolean;
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

/** The key of the source a book belongs to ("s3" for "s3:1234"). */
export const sourceIdOfBookKey = (bookKey: string): string => bookKey.slice(0, bookKey.indexOf(":"));

/** A heading line of a book (what the generator's regular TOC is built from). */
export interface BookHeading {
  /** 0-based line */
  line: number;
  /** 1–6 */
  level: number;
  /** the heading without tags */
  text: string;
}
