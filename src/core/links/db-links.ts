import { parseConnectionType, type ConnectionType } from "./connection-type";
import type { BookOrigin, Link } from "./model";

/*
 * Links that already exist in an opened database, as the worker lists them for one book (stage 10:
 * "the system must load links that already exist, and not treat every project as new"). Plain data,
 * so that every layer can hold it. The links themselves are ordinary `Link`s with provenance "db",
 * in the STORED direction (side 0 = link.source), read-only.
 */

/** Relative to the listed book: "out" = the book is the stored source (side 0), "in" = the stored target. */
export type DbLinkDirection = "out" | "in";

export interface DbLinkQuery {
  /** one direction only (default: both) */
  dir?: DbLinkDirection;
  /** stored types to keep (default: all) */
  types?: readonly ConnectionType[];
  /** the book at the other end (a book key of the same source) */
  otherBookKey?: string;
  /** lines of the listed book, 0-based inclusive */
  lines?: { from: number; to: number };
  offset: number;
  limit: number;
}

export interface DbLinkTypeCount {
  type: ConnectionType;
  out: number;
  in: number;
}

export interface DbLinkBookCount {
  bookKey: string;
  title: string;
  origin: BookOrigin;
  out: number;
  in: number;
}

/** Counts of a book's database links, from the link table's book indexes (no full-table scan). */
export interface DbLinkSummary {
  bookKey: string;
  total: number;
  out: number;
  in: number;
  byType: DbLinkTypeCount[];
  /** by the book at the other end, most links first */
  byBook: DbLinkBookCount[];
  /** "index": through idx_link_source_book/idx_link_target_book; "scan": the database has neither (slow) */
  method: "index" | "scan";
  /** what reading the summary cost, for the status line and the real-database test */
  ms: number;
}

/** Why a book has no database links to list (no `link` table, text files…), in Hebrew. */
export interface DbLinksUnavailable {
  bookKey: string;
  reason: string;
  /** the read was cancelled or failed — trying again may work */
  retry?: boolean;
}

export interface DbLinkPage {
  /** links matching the query, before paging */
  total: number;
  offset: number;
  /** in the listed book's line order, then by link id */
  links: Link[];
}

/**
 * Where a database link most likely came from. The database does not record it (baseProvenance is
 * about the base→dependant ORIENTATION, not the origin — SefariaLinksImporter.kt:1120-1133), so it
 * is inferred from the stored type and the two books (docs/contracts/LINK_FORMATS.md §4.5):
 *   linker   — the LINKER layer, rebuilt by the LinkerToOtzaria pipeline on every build (§1.10);
 *   sefaria  — both books from Sefaria: Sefaria's own links export, or links the generator infers
 *              (commentary anchors) — never from a library links file (the generator drops
 *              Sefaria↔Sefaria records, §1.4 gate 2);
 *   personal — a personal or attached database, not the official one;
 *   library  — everything else: a `_links.json` of the library, or a layer a generator script adds
 *              (e.g. GenerateHavroutaLinks). The database cannot tell these apart.
 */
export type DbLinkOrigin = "linker" | "sefaria" | "personal" | "library";

export function dbLinkOrigin(l: Pick<Link, "source" | "target" | "declaredType">): DbLinkOrigin {
  if (parseConnectionType(l.declaredType).type === "LINKER") return "linker";
  if (l.source.book.origin === "personal" || l.target.book.origin === "personal") return "personal";
  if (l.source.book.origin === "sefaria" && l.target.book.origin === "sefaria") return "sefaria";
  return "library";
}

export const DB_LINK_ORIGIN_LABELS: Readonly<Record<DbLinkOrigin, { he: string; hint: string }>> = {
  linker: { he: "שכבת LINKER", hint: "ציטוטים שזוהו אוטומטית בפייפליין של אוצריא. נבנים מחדש בכל בנייה, ואי אפשר לכתוב אותם בקובץ קישורים" },
  sefaria: { he: "ספריא", hint: "שני הספרים מספריא: קישור מהייצוא של ספריא או קישור שהגנרטור הסיק. לא מקובץ קישורים של הספרייה" },
  personal: { he: "מסד אישי", hint: "קישור ממסד אישי או מצורף, לא מהמסד הרשמי" },
  library: { he: "ספריית אוצריא", hint: "כנראה מקובץ ‎_links.json בספרייה (או משכבה שסקריפט של הגנרטור מוסיף). המסד לא שומר מאיזה קובץ" },
};

/** The database's id of a "db" link (`<sourceId>:link:<id>`), or null for any other link. */
export function dbLinkId(l: Pick<Link, "id" | "provenance">): number | null {
  if (l.provenance !== "db") return null;
  const m = /:link:(\d+)$/.exec(l.id);
  return m ? Number(m[1]) : null;
}
