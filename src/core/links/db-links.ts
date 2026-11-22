import { parseConnectionType, type ConnectionType } from "./connection-type";
import { DB_LINK_FLAGS, type BookOrigin, type DbLinkFlag, type Link } from "./model";

export { DB_LINK_FLAGS, type DbLinkFlag };

/** The flags in the user's words (the panel shows them; docs/research/PERSONAL_DB_V52_AUDIT.md §5 has the real counts). */
export const DB_LINK_FLAG_LABELS: Readonly<Record<DbLinkFlag, { he: string; hint: string }>> = {
  "target-out-of-range": { he: "יעד מחוץ לספר", hint: "שורת היעד גדולה ממספר השורות של ספר היעד: הקישור כנראה מצביע על ספר אחר או על גרסה אחרת" },
  "header-target": { he: "היעד הוא כותרת", hint: "שורת היעד היא כותרת (יש לה ערך בתוכן העניינים)" },
  "header-source": { he: "המקור הוא כותרת", hint: "שורת המקור היא כותרת: אוצריא של הספרייה מדלגת על קישור כזה" },
  "reverse-duplicate": { he: "כפילות הפוכה", hint: "אותן שתי שורות מקושרות גם בכיוון ההפוך: באפליקציה זה קישור כפול" },
  "ambiguous-title": { he: "כותרת עמומה", hint: "שם ספר היעד הוא גם שם של ספר בספרייה הרשמית, ולא ידוע לאיזה מהם הקישור התכוון" },
  "source-out-of-range": { he: "המקור מחוץ לספר", hint: "שורת המקור גדולה ממספר השורות של ספר המקור: השורה הזאת לא קיימת בספר" },
};

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
  /** only links that carry this flag */
  flag?: DbLinkFlag;
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
  /**
   * Of those, COMMENTARY links. The library stores every one base → commentary (12,830 pairs in the
   * full database, none the other way), so "out" means the other book is a commentary on this one and
   * "in" that this book is a commentary on it — the max-link planner's evidence (linking/plan.ts).
   */
  commentaryOut: number;
  commentaryIn: number;
  /**
   * Of those, TARGUM and MIDRASH links. Stored base → dependant like COMMENTARY (the full database,
   * checked 2026-11-12: all 40,741 TARGUM and 10,689 MIDRASH links, e.g. "בראשית" → "תרגום ותפסיר רסג").
   */
  targumOut: number;
  targumIn: number;
  midrashOut: number;
  midrashIn: number;
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
  /** how many of the book's links carry each flag (only those with any; external_link databases only) */
  flags?: { flag: DbLinkFlag; count: number }[];
  /**
   * external_link rows that could not become a listed link, counted instead of dropped unseen (only when there are
   * any): `badLine` a line number that is not a whole non-negative number (and no ref to go by), `noPlace` neither a
   * target line nor a ref, `orphanSource` rows of the whole database whose source book does not exist.
   */
  unlisted?: { badLine: number; noPlace: number; orphanSource: number };
  /**
   * Only for a database that has BOTH a `link` table and `external_link`: what the merge did. `link` and `externalLink` are
   * the links of this book each table gave to the list; `duplicatesDropped` external_link rows were left out because the
   * `link` table says the same link (same own line, other book, other line and type); `incomingUnchecked` external_link
   * rows into this book are listed without being compared with the `link` table (its far end is not known without a
   * lookup), so a link that both tables hold may appear twice among them.
   */
  tables?: { link: number; externalLink: number; duplicatesDropped: number; incomingUnchecked: number };
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
  linker: { he: "זיהוי אוטומטי", hint: "ציטוטים שאוצריא מזהה לבד. הם נבנים מחדש בכל בנייה של המסד, ואי אפשר לכתוב אותם בקובץ קישורים" },
  sefaria: { he: "ספריא", hint: "שני הספרים מספריא: קישור שהגיע מספריא, או שאוצריא הסיקה בבניית המסד. לא מקובץ קישורים של הספרייה" },
  personal: { he: "מסד אישי", hint: "קישור ממסד אישי או מצורף, לא מהמסד הרשמי" },
  library: { he: "ספריית אוצריא", hint: "כנראה מקובץ קישורים של הספרייה (או מקישורים שהספרייה מוסיפה בבניית המסד). המסד לא שומר מאיזה קובץ" },
};

/** The database's id of a "db" link (`<sourceId>:link:<id>`), or null for any other link. */
export function dbLinkId(l: Pick<Link, "id" | "provenance">): number | null {
  if (l.provenance !== "db") return null;
  const m = /:link:(\d+)$/.exec(l.id);
  return m ? Number(m[1]) : null;
}
