import type { CoverageSummary } from "../../linking/coverage";

/*
 * The coverage panel's count, as plain functions (so that they are tested without a page): one count never throws, and a count
 * that failed is remembered by the book and the revision of the links it was asked for, so the panel's "the links changed, count
 * again" rule does not ask for it again by itself (it used to: a count that gave nothing left the old summary stale, and the
 * rule fired once more, forever; a count that threw left the button locked).
 */
export type PanelSummary = CoverageSummary & { bookKey: string; revision: number };
export interface FailedCount {
  bookKey: string;
  revision: number;
  message: string;
}

export const NOT_OPEN_MESSAGE = "אי אפשר לחשב כיסוי: הספר לא פתוח, או שאורכו עדיין לא ידוע. פתחו אותו בקורא ונסו שוב.";

export type CountOutcome = { ok: true; summary: PanelSummary } | { ok: false; failed: FailedCount };

/** Runs one count; a null result (book closed, task cancelled) or an error is a failure with a message, never an exception. */
export async function countCoverage(count: (bookKey: string) => Promise<CoverageSummary | null>, bookKey: string, revision: number): Promise<CountOutcome> {
  try {
    const s = await count(bookKey);
    if (!s) return { ok: false, failed: { bookKey, revision, message: NOT_OPEN_MESSAGE } };
    return { ok: true, summary: { ...s, bookKey, revision } };
  } catch (err) {
    return { ok: false, failed: { bookKey, revision, message: `חישוב הכיסוי נכשל: ${(err as Error).message ?? err}` } };
  }
}

/**
 * Whether the counted summary of this book should be counted again by itself: the links changed since it was counted, nothing is
 * running, and that very revision was not just tried and failed (the user's own "count again" is not bound by this).
 */
export function needsRecount(s: { summary: PanelSummary | null; bookKey: string | null | undefined; revision: number; busy: boolean; failed: FailedCount | null }): boolean {
  const { summary, bookKey, revision, busy, failed } = s;
  if (!summary || !bookKey || busy || summary.bookKey !== bookKey || summary.revision === revision) return false;
  return !(failed && failed.bookKey === bookKey && failed.revision === revision);
}
