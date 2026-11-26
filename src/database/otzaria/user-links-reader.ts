import { parseConnectionType, CONNECTION_TYPES } from "../../core/links/connection-type";
import type { SqliteFile, TableInfo } from "../sqlite/lazy/sqlite-file";
import { USER_LINK_REQUIRED, type DbCapabilities, type UserLinkSchema } from "./capabilities";
import { isLineNumber, type UnlistedCounts } from "./external-links-reader";

/*
 * The personal links of Otzaria's user_books.db: table `user_link` (docs/contracts/LINK_SCHEMA_MATRIX.md §6.1). Read the way the
 * app reads it (Otzaria/otzaria @ a6be90800):
 *
 *   sourceTitle/targetTitle      each side is a book named by its exact title — never an id, so a side can be a book of the
 *   sourceIsUserBook/targetIs…   official library (flag 0), of user_books.db itself (flag 1: a personal book), or of an attached
 *   sourceDb/targetDb            database (its slug; the flag is then 0). UserLinkRecord._origin, user_import_models.dart:399-405;
 *                                NULL flag = 0 (`as int? ?? 0`, user_content_repository.dart:673-692)
 *   source/targetCategoryId      narrows a title the app finds twice (NULL = any), user_content_repository.dart:565-567, 609-611
 *   sourceLineIndex, target…     0-based (user_import_models.dart:340-341); a row with no targetLineIndex is not shown
 *                                (user_links_loader.dart:64-70)
 *   source/targetLineIndexEnd    0-based inclusive range ends (user_import_models.dart:367-369)
 *   anchorStart/anchorEnd/Label  on the SOURCE line, raw offsets exactly as the native links file wrote them
 *                                (user_import_models.dart:360-365; user_links_loader.dart:113-117 "anchorOffsetsAreRaw")
 *   connectionType               the type's name as text (LinkTypes, link_types.dart)
 *
 * The first layout ("book-id", database.dart @ 65db26bd2) names the source by sourceBookId — a personal book of this database —
 * and has no anchors, ranges or slugs. Which layout a table is comes from its columns (capabilities.ts userLinkSchema).
 *
 * The table is read in one scan, kept in compact arrays (`UserLinkIndex`), and a page reads its rows by rowid (the `id` column is
 * the rowid). It is the user's own imports — thousands of rows, not millions — so no per-book index of the table is needed;
 * the app's own indexes are by title, which a per-book lookup here could use only for one side. Read-only like every reader.
 */
export interface UserLinkSide {
  title: string;
  /** the isUserBook flag: true for 1, false for 0 or NULL (as the app reads it); null when it is not an integer (the side is unknown) */
  user: boolean | null;
  /** the attached database's slug when the row names a valid one (else the flag decides, like the app) */
  db: string | null;
  category: number | null;
  /** the "book-id" layout's source: a book id of THIS database */
  bookId: number | null;
}

export interface UserLinkRow {
  rowid: number;
  source: UserLinkSide;
  target: UserLinkSide;
  /** null when the stored value is not a whole non-negative number */
  sourceLine: number | null;
  targetLine: number | null;
  /** targetLineIndex is NULL: the app does not show the row */
  targetLineMissing: boolean;
  /** a whole non-negative stored end, else undefined; whether it is a real range end is decided with the book (rangeEnd) */
  sourceEnd?: number;
  targetEnd?: number;
  targetRef: string | null;
  anchor?: { start: number; end?: number; label?: string };
  /** connectionType as stored */
  typeName: string | null;
}

/** The rows of the whole table that touch this database's books, as parallel arrays. */
export interface UserLinkIndex {
  readonly rowid: Float64Array;
  /** a book of this database (its id), or -1 (a book of the library or of another database: see `sides`) */
  readonly sourceBook: Int32Array;
  readonly targetBook: Int32Array;
  readonly sourceLine: Int32Array;
  readonly targetLine: Int32Array;
  /** index into CONNECTION_TYPES */
  readonly type: Uint8Array;
  /** index into `sides`, for the side that is not a book of this database */
  readonly sourceSide: Int32Array;
  readonly targetSide: Int32Array;
  readonly sides: readonly UserLinkSide[];
  /** per own book: the positions of the rows that start in it ("out"), and of those that end in it and do not also start there ("in") */
  readonly out: ReadonlyMap<number, readonly number[]>;
  readonly in: ReadonlyMap<number, readonly number[]>;
  /** per own book: its rows that are no link (a line that is no line, no target line, a flag that is no flag) */
  readonly unlistedByBook: ReadonlyMap<number, UnlistedCounts>;
  /** "book-id" rows whose sourceBookId is no book of this database (database-wide) */
  readonly orphanSource: number;
  /** rows whose two sides are books of the library or of other databases: not listed by this database (a known limitation) */
  readonly foreign: number;
}

/** BookSource.isValidSlug (book_source.dart:23-29): an invalid slug is ignored and the flag decides (user_import_models.dart:402-405) */
const SLUG = /^[\p{L}\p{N}._-]{1,64}$/u;

/**
 * Where a side is: a book id of this database, -1 when it is not one of its books (the library, another database, or a personal
 * book this database does not have), -2 when a "book-id" source names no book. For a side whose flag is unknown, the book of
 * its title, if any (the row is then counted there as unlisted, never listed).
 */
export type OwnBookOf = (side: UserLinkSide) => number;

export class UserLinksReader {
  private constructor(
    private readonly file: SqliteFile,
    private readonly t: TableInfo,
    readonly schema: UserLinkSchema,
    private readonly c: Record<(typeof COLUMNS)[number], number>,
  ) {}

  /**
   * null when the database has no user_link, or one it cannot read: a layout without a column both layouts need, or a table
   * declared WITHOUT ROWID (rows are read by rowid). Then `problem` says so with the code db/user-link-not-read: the books'
   * link counts are NOT "0" (DbBookSource marks every book of the database linksUnread).
   */
  static async open(file: SqliteFile, caps: DbCapabilities, problem?: (p: { code: "db/user-link-not-read"; message: string }) => void): Promise<UserLinksReader | null> {
    if (!caps.userLinks) return null;
    const t = await file.table("user_link");
    if (!t) return null;
    const what = "במסד יש טבלת קישורים אישיים של אוצריא (user_link)";
    const after = "הקישורים האישיים שבה לא נקראו, ולכן מספר הקישורים של ספרי המסד לא ידוע (הוא אינו אפס). פתחו את המסד פעם אחת בגרסה עדכנית של אוצריא, שמעדכנת את מבנה הטבלה, ופתחו אותו כאן שוב.";
    if (!caps.userLinkSchema) {
      const has = new Set(t.columns.map((x) => x.name.toLowerCase()));
      const missing = USER_LINK_REQUIRED.title.filter((n) => !has.has(n.toLowerCase()));
      problem?.({ code: "db/user-link-not-read", message: `${what} במבנה שהכלי אינו מכיר (חסרות העמודות ${missing.join(", ")}). ${after}` });
      return null;
    }
    if (t.withoutRowid) {
      problem?.({ code: "db/user-link-not-read", message: `${what}, מוגדרת WITHOUT ROWID, ואוצריא קוראת את השורות שלה לפי מספר השורה. ${after}` });
      return null;
    }
    const at = (n: string) => t.columns.findIndex((x) => x.name.toLowerCase() === n.toLowerCase());
    const c = Object.fromEntries(COLUMNS.map((n) => [n, at(n)])) as Record<(typeof COLUMNS)[number], number>;
    return new UserLinksReader(file, t, caps.userLinkSchema, c);
  }

  private row(rowid: number, v: readonly unknown[]): UserLinkRow {
    const c = this.c;
    const raw = (i: number) => (i < 0 ? null : (v[i] ?? null));
    const str = (i: number) => {
      const x = raw(i);
      return x === null ? null : String(x);
    };
    const int = (i: number): number | null => (isLineNumber(raw(i)) ? Number(raw(i)) : null);
    const flag = (i: number): boolean | null => {
      const x = raw(i);
      if (x === null) return false;
      if ((typeof x === "number" && Number.isInteger(x)) || typeof x === "bigint") return Number(x) === 1;
      return null;
    };
    const slug = (i: number) => {
      const s = str(i);
      return s !== null && SLUG.test(s) ? s : null;
    };
    const category = (i: number) => {
      const x = raw(i);
      return (typeof x === "number" && Number.isInteger(x)) || typeof x === "bigint" ? Number(x) : null;
    };
    const source: UserLinkSide =
      this.schema === "book-id"
        ? { title: "", user: true, db: null, category: null, bookId: category(c.sourceBookId) ?? Number.NaN }
        : { title: str(c.sourceTitle) ?? "", user: flag(c.sourceIsUserBook), db: slug(c.sourceDb), category: category(c.sourceCategoryId), bookId: null };
    const target: UserLinkSide = { title: str(c.targetTitle) ?? "", user: flag(c.targetIsUserBook), db: slug(c.targetDb), category: category(c.targetCategoryId), bookId: null };
    const start = int(c.anchorStart);
    const end = int(c.anchorEnd);
    const label = str(c.anchorLabel)?.trim();
    const sourceEnd = int(c.sourceLineIndexEnd);
    const targetEnd = int(c.targetLineIndexEnd);
    return {
      rowid,
      source,
      target,
      sourceLine: int(c.sourceLineIndex),
      targetLine: int(c.targetLineIndex),
      targetLineMissing: raw(c.targetLineIndex) === null,
      ...(sourceEnd !== null && { sourceEnd }),
      ...(targetEnd !== null && { targetEnd }),
      targetRef: str(c.targetRef),
      // an end that is not after the start is no end (RawAnchor.rawEnd is exclusive)
      ...(start !== null && { anchor: { start, ...(end !== null && end > start && { end }), ...(label && { label }) } }),
      typeName: str(c.connectionType),
    };
  }

  async byRowids(ids: Iterable<number>): Promise<UserLinkRow[]> {
    const got = await this.file.getMany(this.t, ids);
    return [...got].sort((a, b) => a[0] - b[0]).map(([id, r]) => this.row(id, r.values));
  }

  /** One scan of the table into the rows that touch this database's books (see UserLinkIndex). */
  async index(ownOf: OwnBookOf, ctx: { signal?: AbortSignal; progress?: (done: number, total: number) => void } = {}): Promise<UserLinkIndex> {
    const cap = { rowid: [] as number[], sb: [] as number[], tb: [] as number[], sl: [] as number[], tl: [] as number[], ty: [] as number[], ss: [] as number[], ts: [] as number[] };
    const sides: UserLinkSide[] = [];
    const sideAt = new Map<string, number>();
    const sideOf = (s: UserLinkSide) => {
      const k = `${s.user}\u0000${s.db ?? ""}\u0000${s.title}`;
      let i = sideAt.get(k);
      if (i === undefined) sideAt.set(k, (i = sides.push(s) - 1));
      return i;
    };
    const unlistedByBook = new Map<number, UnlistedCounts>();
    const unlisted = (b: number, why: keyof UnlistedCounts) => {
      if (b < 0) return;
      const u = unlistedByBook.get(b) ?? (unlistedByBook.set(b, { badLine: 0, noPlace: 0 }), unlistedByBook.get(b)!);
      u[why]++;
    };
    let orphanSource = 0;
    let foreign = 0;
    let n = 0;
    for await (const r of this.file.scan(this.t)) {
      if (++n % 50_000 === 0) ctx.signal?.throwIfAborted();
      const row = this.row(Number(r.rowid), r.values);
      const sb = ownOf(row.source);
      if (sb === -2) {
        orphanSource++;
        continue;
      }
      const tb = ownOf(row.target);
      if (sb < 0 && tb < 0) {
        foreign++;
        continue;
      }
      // a row that cannot be placed is no link: counted in the books it touches (once in a book linked to itself), never listed
      const why: keyof UnlistedCounts | null = row.sourceLine === null || (row.targetLine === null && !row.targetLineMissing) ? "badLine" : row.targetLineMissing || row.source.user === null || row.target.user === null ? "noPlace" : null;
      if (why) {
        unlisted(sb, why);
        if (tb !== sb) unlisted(tb, why);
        continue;
      }
      cap.rowid.push(row.rowid);
      cap.sb.push(sb);
      cap.tb.push(tb);
      cap.sl.push(row.sourceLine!);
      cap.tl.push(row.targetLine!);
      cap.ty.push(CONNECTION_TYPES.indexOf(this.typeOf(row.typeName)));
      cap.ss.push(sb < 0 ? sideOf(row.source) : -1);
      cap.ts.push(tb < 0 ? sideOf(row.target) : -1);
    }
    const out = new Map<number, number[]>();
    const into = new Map<number, number[]>();
    const add = (m: Map<number, number[]>, b: number, i: number) => {
      const list = m.get(b);
      if (list) list.push(i);
      else m.set(b, [i]);
    };
    cap.rowid.forEach((_, i) => {
      if (cap.sb[i]! >= 0) add(out, cap.sb[i]!, i);
      if (cap.tb[i]! >= 0 && cap.tb[i] !== cap.sb[i]) add(into, cap.tb[i]!, i);
    });
    return {
      rowid: Float64Array.from(cap.rowid),
      sourceBook: Int32Array.from(cap.sb),
      targetBook: Int32Array.from(cap.tb),
      sourceLine: Int32Array.from(cap.sl),
      targetLine: Int32Array.from(cap.tl),
      type: Uint8Array.from(cap.ty),
      sourceSide: Int32Array.from(cap.ss),
      targetSide: Int32Array.from(cap.ts),
      sides,
      out,
      in: into,
      unlistedByBook,
      orphanSource,
      foreign,
    };
  }

  /** NULL or empty is REFERENCE (the app's import, OTZARIA_COMPATIBILITY §4); every other name goes through the generator's parser (unknown → OTHER) */
  typeOf(name: string | null): (typeof CONNECTION_TYPES)[number] {
    return name === null || name.trim() === "" ? "REFERENCE" : parseConnectionType(name).type;
  }
}

const COLUMNS = [
  "sourceBookId",
  "sourceTitle",
  "sourceCategoryId",
  "sourceIsUserBook",
  "sourceLineIndex",
  "sourceLineIndexEnd",
  "sourceDb",
  "targetTitle",
  "targetCategoryId",
  "targetIsUserBook",
  "targetLineIndex",
  "targetLineIndexEnd",
  "targetRef",
  "targetDb",
  "anchorStart",
  "anchorEnd",
  "anchorLabel",
  "connectionType",
] as const;
