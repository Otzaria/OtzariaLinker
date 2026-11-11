/*
 * The internal link model (docs/contracts/LINK_FORMATS.md §3). One model, independent of every
 * format; importers/exporters convert at the boundary. Indexes are 0-based everywhere inside.
 * Objects are immutable — changes produce new objects through src/linking actions.
 */

export type BookOrigin = "otzaria" | "sefaria" | "personal" | "unknown";

export interface BookRef {
  /** Stable internal key, unique across all open sources (e.g. "db:official:1234", "txt:folder/x.txt"). */
  readonly key: string;
  /** The title exactly as the generator/database sees it — this is what path_2 and the file name carry. */
  readonly title: string;
  readonly origin: BookOrigin;
  /** Sefaria priority-list base book (Tanakh, Bavli…). undefined = not known; affects flip/downgrade. */
  readonly isBaseBook?: boolean;
}

export interface LinkSide {
  readonly book: BookRef;
  /** 0-based line */
  readonly line: number;
  /** 0-based inclusive last line of a range; absent (or equal to `line`) = a single line */
  readonly end?: number;
}

/**
 * A word anchor on the SOURCE line, in RAW offsets into the line as the generator will see it
 * (the source of truth for export). `contentHash` identifies that line text, so a later edit of
 * the book can be detected before the anchor silently points at other words.
 */
export interface RawAnchor {
  readonly rawStart: number;
  /** exclusive */
  readonly rawEnd?: number;
  readonly label?: string;
  readonly contentHash?: string;
}

/** An anchor read from link_anchor in a database: VISIBLE offsets, possibly on either stored side. */
export interface DbAnchor {
  readonly side: 0 | 1;
  readonly charStart: number;
  readonly charEnd?: number;
  readonly label?: string;
}

export type LinkStatus = "new" | "edited" | "existing" | "deleted";

/**
 * Where the link came from. Only "file" links (and the user's own) may be written back to a links
 * file: a "db" link cannot be turned into an identical record (LINK_FORMATS §4.4) and is read-only.
 */
export type Provenance = "file" | "db" | "user" | "auto";

export interface Link {
  readonly id: string;
  readonly status: LinkStatus;
  readonly provenance: Provenance;
  /** Direction of the FILE: the source book owns the `<source>_links.json`. */
  readonly source: LinkSide;
  readonly target: LinkSide;
  /** Raw "Conection Type" exactly as it will be written (canonical lower-case for new links). */
  readonly declaredType: string;
  /** heRef_2: display label of the target; required in the file; not stored in the database. */
  readonly heRef2: string;
  readonly ref1?: string;
  readonly ref2?: string;
  readonly anchor?: RawAnchor;
  readonly dbAnchors?: readonly DbAnchor[];
  /** Pipeline fields (anchor_src_hash, anchor_context) and unknown keys, kept for a lossless round-trip. */
  readonly passthrough?: Readonly<Record<string, unknown>>;
  /** Key order of the imported record — re-exported unchanged for a minimal diff. */
  readonly keyOrder?: readonly string[];
  /** path_2 exactly as imported (it may carry a folder); kept while it still names target.book */
  readonly targetPath?: string;
}

export const isRange = (s: LinkSide): boolean => s.end !== undefined && s.end > s.line;
