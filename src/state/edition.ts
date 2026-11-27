import type { SourceLine } from "../core/books";
import type { BookOrigin } from "../core/links/model";
import { editionFingerprint, editionSampleLines } from "../core/text/fingerprint";

/*
 * Book and edition identity (V7 §1.1, docs/contracts/DATABASE_SUPPORT_MATRIX.md §9).
 *
 * A saved project names a book by its title, its origin and the label of the source it was read from — and records, once per
 * book, how many lines it had and its EDITION (core/text/fingerprint.ts editionFingerprint: the line count and a fingerprint of
 * 32 sampled lines). The edition is read lazily, a few lines per book, only for books that links use: never a hash of a whole
 * database. It decides two things: whether a book open now is the same edition as the one the links were made on (a renamed or
 * copied file binds; another edition never binds silently), and whether a book changed since (export/book-changed).
 */

/** What is known of a book the project's links were made on: its identity, its lines then, and its edition then. */
export interface BookRecord {
  title: string;
  /** absent: a project saved before V7 (by title only) */
  origin?: BookOrigin;
  /** the label of its source (StoredBook.source); absent when not known */
  source?: string;
  lines: number;
  /** editionFingerprint when it was saved; absent when it was not read (an older project, a book never read) */
  edition?: string;
}

/** The key of a book's identity: title, origin and source label. */
export const recordId = (title: string, origin?: BookOrigin, source?: string): string => `${origin ?? ""}\u0000${source ?? ""}\u0000${title}`;

/**
 * A record's own key: its identity and its edition. Two books of one identity — two folders, each with a "user_books.db" that
 * has a book of that title — are two records, told apart by their editions (item 6).
 */
export const keyOfRecord = (r: Pick<BookRecord, "title" | "origin" | "source" | "edition">): string => `${recordId(r.title, r.origin, r.source)}\u0000${r.edition ?? ""}`;

/**
 * Reads a book's edition: the sampled lines, one by one (a database reads only their pages). `count` is the book's line count.
 * A line the source does not have (a database may skip a number) counts as missing, the same way every time.
 */
export async function readEdition(lines: (bookKey: string, from: number, to: number) => Promise<SourceLine[]>, bookKey: string, count: number): Promise<string> {
  const at = editionSampleLines(count);
  const texts = await Promise.all(at.map(async (i) => (await lines(bookKey, i, i)).find((l) => l.index === i)?.text));
  return editionFingerprint(count, at, texts);
}
