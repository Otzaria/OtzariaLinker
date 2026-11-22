import type { BookRef } from "../../core/links/model";

/** the verdicts are kept per pair of BOOKS (a same-titled book from another source is another pair) */
export const fitKey = (p: { dependant: BookRef; base: BookRef }): string => `${p.dependant.key}>${p.base.key}`;

/** a few pairs are checked at once; a long list is checked a pair at a time, on request */
export const MAX_AUTO = 12;

/**
 * The pairs the plan's screen checks by itself (titleFit reads two whole books per pair): only a short list, never a notes book,
 * and never a pair that has an answer already — including the answer "could not be checked" (null): that one stays until the user
 * asks again with the button, instead of being read again on every change of the plan.
 */
export function pairsToAutoCheck<P extends { dependant: BookRef; base: BookRef; notes: boolean }>(pairs: readonly P[], fits: Readonly<Record<string, unknown>>): P[] {
  if (!pairs.length || pairs.length > MAX_AUTO) return [];
  return pairs.filter((p) => !p.notes && !(fitKey(p) in fits));
}
