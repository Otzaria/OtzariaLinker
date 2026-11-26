import { linksReadingText, type CoverageSummary, type LinksReading } from "../../linking/coverage";

/*
 * The coverage panel's count, as plain functions (so that they are tested without a page): one count never throws, and a count
 * that failed is remembered by the book and the revision of the links it was asked for, so the panel's "the links changed, count
 * again" rule does not ask for it again by itself (it used to: a count that gave nothing left the old summary stale, and the
 * rule fired once more, forever; a count that threw left the button locked).
 */
export type PanelSummary = CoverageSummary & { bookKey: string; revision: number; /** what the read of the database's links said (absent: a saved coverage, which is only ever saved when reliable) */ links?: LinksReading };
export interface FailedCount {
  bookKey: string;
  revision: number;
  message: string;
  /** the user stopped the count: remembered like a failure (it is not asked again by itself), but said with no message, as no error */
  cancelled?: true;
}

/**
 * Whether the counts of a coverage may be shown as the truth (linking/coverage.ts LinksReading). "counted" and "none" are: a book
 * with no links in the database IS all unlinked. "failed" and "unknown" are not: the database's links were not read, so a zero or
 * "100% unlinked" would say that the book has no links when nobody knows. A saved coverage has no reading and is reliable (a coverage
 * that is not counted/none is never saved).
 */
export type CoverageTrust = { reliable: true } | { reliable: false; kind: "failed" | "unknown"; text: string };
export function coverageTrust(links: LinksReading | undefined): CoverageTrust {
  // a text book has no database (#42 C14): its project count is the whole truth
  if (!links || links.state === "counted" || links.state === "none" || links.state === "no-database") return { reliable: true };
  return { reliable: false, kind: links.state, text: linksReadingText(links) };
}

export const NOT_OPEN_MESSAGE = "אי אפשר לחשב כיסוי: הספר לא פתוח, או שאורכו עדיין לא ידוע. פתחו אותו בקורא ונסו שוב.";

export type CountOutcome = { ok: true; summary: PanelSummary } | { ok: false; failed: FailedCount };

/**
 * Runs one count; an error is a failure with a message, never an exception. A null result is either a book that is not open (a failure
 * with the "not open" message) or a task the user stopped (`isOpen` says the book is there): that one is no failure.
 */
export async function countCoverage(count: (bookKey: string) => Promise<(CoverageSummary & { links?: LinksReading }) | null>, bookKey: string, revision: number, isOpen: (bookKey: string) => boolean = () => false): Promise<CountOutcome> {
  try {
    const s = await count(bookKey);
    if (!s) {
      if (isOpen(bookKey)) return { ok: false, failed: { bookKey, revision, message: "", cancelled: true } };
      return { ok: false, failed: { bookKey, revision, message: NOT_OPEN_MESSAGE } };
    }
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
