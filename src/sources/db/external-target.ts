import type { BookOrigin } from "../../core/links/model";

/*
 * Where an external_link row points (a personal database's links, ExternalLinksReader): a book of ANOTHER
 * open source — usually the official library — named by title. The database cannot find it, the registry can:
 * it holds every open source. Resolution is lazy and never cached inside a listing, so a library opened AFTER
 * the personal database still resolves (the registry tells the databases when its sources change).
 */
export interface TargetBook {
  key: string;
  title: string;
  origin: BookOrigin;
  isBaseBook?: boolean;
}

export interface ExternalTargetResolver {
  /**
   * The open book with this exact title in the source `targetSource` names ('official': the library; another
   * attached database's library_id; null: any, the library first), never one of `from` itself. null when no
   * such source or book is open.
   */
  book(title: string, targetSource: string | null, from: string): Promise<TargetBook | null>;
  /** The 0-based line of an open book whose heRef is `heRef` (the first one), or null when it has none or the book has no references. */
  lineOfRef(bookKey: string, heRef: string): Promise<number | null>;
}
