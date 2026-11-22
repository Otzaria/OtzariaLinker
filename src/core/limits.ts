/*
 * Sanity limits for numbers that come from files and databases nobody vouches for (QA round 2, B and C).
 * One place, so the import, the readers and the loops agree.
 */

/** Most lines a single book may have: a larger count from a database is a corrupt or hostile one, not a book. */
export const MAX_BOOK_LINES = 5_000_000;

/**
 * Most lines a loop walks for one range. Real ranges are a chapter or a daf (hundreds of lines); a range
 * is also refused at import beyond MAX_BOOK_LINES, and this clamps what reaches a loop by another way.
 */
export const MAX_RANGE_SCAN = 100_000;

/** The last line of [line, end] a loop may visit. */
export const scanEnd = (line: number, end: number): number => Math.min(end, line + MAX_RANGE_SCAN);
