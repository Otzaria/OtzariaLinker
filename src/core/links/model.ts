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

/**
 * The words an automatic method matched on the line of each side of a link (issue #11), raw UTF-16 offsets into the line as
 * stored, end exclusive — the same convention as RawAnchor. Only a note for a screen to highlight: it lives in the saved
 * project and NEVER in an exported record (formats/links-json/convert.ts writes named fields only), so the library's
 * file format is unchanged. The same shape as `MatchedWords` of a suggestion (linking/automatic/types.ts).
 */
export interface LinkMatched {
  readonly source?: { readonly rawStart: number; readonly rawEnd: number };
  readonly target?: { readonly rawStart: number; readonly rawEnd: number };
}

/** An anchor read from link_anchor in a database: VISIBLE offsets, possibly on either stored side. */
export interface DbAnchor {
  readonly side: 0 | 1;
  readonly charStart: number;
  readonly charEnd?: number;
  readonly label?: string;
}

/**
 * What a reader should know about an EXISTING database link before trusting it (a personal database's external_link,
 * #13): the target line is past the end of its book; the target or the source line is a heading; the same two lines
 * are linked the other way round too (AGENTS §3: a reversed record is a duplicate link); the target title is the name
 * of two books (the database's own and the library's), so which one was meant is not known. Only a note on a "db"
 * link: it is never exported, and a copy to the project does not carry it.
 */
export const DB_LINK_FLAGS = ["target-out-of-range", "header-target", "header-source", "reverse-duplicate", "ambiguous-title", "source-out-of-range"] as const;
export type DbLinkFlag = (typeof DB_LINK_FLAGS)[number];

export type LinkStatus = "new" | "edited" | "existing" | "deleted";

/**
 * Where the link came from. Only "file" links (and the user's own) may be written back to a links
 * file: a "db" link cannot be turned into an identical record (LINK_FORMATS §4.4) and is read-only.
 * "db-copy" is a project link the user copied from a database link ("העתקה לפרויקט",
 * src/core/links/from-db.ts): an ordinary, editable, exportable link whose record was RECONSTRUCTED,
 * so the export insists that its book's links file is loaded first (validate.ts).
 * "import" is a NEW link read from a spreadsheet or a records file (CSV, JSON in another layout): it
 * goes through the links-file parser, but it is not the library's file — it is validated like any
 * new link and never stands in for the book's library file (security review A1).
 */
export type Provenance = "file" | "db" | "user" | "auto" | "db-copy" | "import";

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
  /** an approved suggestion's matched words, so the readers can show them again after a save and a reopen (see LinkMatched) */
  readonly matched?: LinkMatched;
  readonly dbAnchors?: readonly DbAnchor[];
  /** database links only: what to doubt about this link (see DbLinkFlag) */
  readonly dbFlags?: readonly DbLinkFlag[];
  /** database links only: stored sides Sefaria hides (link_suppressed_side) — not expressible in a file */
  readonly dbSuppressed?: readonly (0 | 1)[];
  /** Pipeline fields (anchor_src_hash, anchor_context) and unknown keys, kept for a lossless round-trip. */
  readonly passthrough?: Readonly<Record<string, unknown>>;
  /** Key order of the imported record — re-exported unchanged for a minimal diff. */
  readonly keyOrder?: readonly string[];
  /** the imported record had `"Conection Type": null` — written back as null while the type stays empty */
  readonly typeNull?: boolean;
  /** path_2 exactly as imported (it may carry a folder); kept while it still names target.book */
  readonly targetPath?: string;
  /** position of the record in its imported links file — keeps the file's order on export */
  readonly fileIndex?: number;
  /**
   * A "deleted" link only: the status it had before the deletion, which a restore gives back — so an
   * untouched library record is untouched again, and the export writes it as it was (review C1).
   */
  readonly restoreStatus?: Exclude<LinkStatus, "deleted">;
  /**
   * The record's exact text in its imported file, kept only when the writer's own output would spell
   * it differently (`126.0`, `"line_index_1": 0`, an odd indentation…). Written back instead of the
   * re-serialized record while the link still means exactly that record (formats/links-json/convert.ts),
   * so an untouched file comes back byte-identical (review C9).
   */
  readonly fileText?: string;
  /**
   * The links files (by file name) this link was found in, when several files of one book were merged
   * (state/link-compare.ts): its origin stays known after the merge. Never written to a links file.
   */
  readonly origins?: readonly string[];
}

export const isRange = (s: LinkSide): boolean => s.end !== undefined && s.end > s.line;
