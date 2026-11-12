import type { BookRef } from "./model";

/*
 * "Does the library's weekly sync treat this book as a Sefaria book" — the question behind every
 * Sefaria rule: ref_1/ref_2, no anchor end, no anchor into Sefaria, no range on a Sefaria side
 * (core/links/validate.ts sefariaChecks). It has ONE answer, decided in the state layer
 * (AppStore.isSefariaOwned, which owns the library's title list and knows each book's source). The
 * export, the quality check and the builder ask that predicate directly (ValidationContext.sefariaOwned);
 * the engines run in the worker, where the list is not loaded, so they get the predicate's answer as
 * the keys of the open books it holds for (the `sefariaOwned` engine option) — and so never propose a
 * link the export then refuses (product audit F1).
 *
 * Without an answer (an engine called directly, a test) the database origin stands in, as it does in
 * validate.ts when the context has no predicate.
 */
export type SefariaOwned = (book: BookRef) => boolean;

/** The stand-in when no one supplied the library's decision: the database says the book came from Sefaria. */
export const sefariaByOrigin: SefariaOwned = (book) => book.origin === "sefaria";

/** The engine option that carries the decision into the worker: keys of the open books it holds for. */
export interface SefariaOwnedOption {
  readonly sefariaOwned?: readonly string[];
}

/** The predicate an engine uses: the keys it was given, else the database origin. */
export function sefariaOwnedOf(keys: readonly string[] | undefined): SefariaOwned {
  if (!keys) return sefariaByOrigin;
  const set = new Set(keys);
  return (book) => set.has(book.key);
}
