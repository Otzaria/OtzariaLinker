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
  /** the book's number of lines, when the source says (a target line past it is flagged) */
  lineCount?: number;
}

/**
 * The slug Otzaria gives an attached database, which user_link's sourceDb/targetDb name: its schema_meta.library_id, else its file
 * name without the extension, lower-cased, marks (niqqud) removed, every run of other characters turned into "-", leading and
 * trailing "-"/"." dropped, at most 64 characters (a re-implementation of AttachedLibraryProbe.slugFor / sanitizeSlug,
 * Otzaria/otzaria lib/attached_libraries/repository/attached_library_probe.dart:203-229 @ a6be90800).
 */
export function otzariaSlug(libraryId: string | undefined, fileName: string): string {
  const sanitize = (raw: string) => {
    const s = raw
      .trim()
      .toLowerCase()
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "");
    const cut = [...s].slice(0, 64).join("");
    return /^[\p{L}\p{N}._-]{1,64}$/u.test(cut) ? cut : "";
  };
  const fromId = libraryId?.trim() ? sanitize(libraryId) : "";
  if (fromId) return fromId;
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
  return sanitize(base) || "db";
}

export interface ExternalTargetResolver {
  /**
   * The open book with this exact title in the source `targetSource` names ('official': the library; another
   * attached database's library_id — or, `by` "slug", its Otzaria slug (otzariaSlug: user_link names databases so); null:
   * any, the library first), never one of `from` itself. null when no such source or book is open.
   */
  book(title: string, targetSource: string | null, from: string, by?: "library-id" | "slug"): Promise<TargetBook | null>;
  /** The 0-based line of an open book whose heRef is `heRef` (the first one), or null when it has none or the book has no references. */
  lineOfRef(bookKey: string, heRef: string): Promise<number | null>;
}
