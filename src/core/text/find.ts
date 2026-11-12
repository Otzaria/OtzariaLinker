import { foldForSearch, foldQuery } from "./hebrew";
import { htmlToPlainText } from "./html";

/*
 * Search inside a book's text (v3 had it in each reader: runFind, legacy/OtzariaLinker-v3.html
 * §6.5). v3 matched stripNikud(stripTags(line)) case-insensitively; here the plain text is the text
 * the reader shows (htmlToPlainText) and the folding also ignores quote variants and punctuation
 * (foldForSearch). A hit is a LINE; the worker scans the book and keeps a capped list of hits.
 */

/** One line that contains the query. */
export interface BookHit {
  /** 0-based line index */
  line: number;
  /** a short piece of the line's plain text around the first match */
  snippet: string;
  /** the first match inside `snippet` [start, end) */
  start: number;
  end: number;
  /** how many times the query occurs in the line */
  count: number;
}

export interface BookSearchResult {
  /** the query as the user typed it */
  query: string;
  /** hits in line order, at most `limit` */
  hits: BookHit[];
  /** lines scanned (the whole book unless cancelled) */
  scanned: number;
  /** more lines matched than were returned */
  truncated: boolean;
}

export const SEARCH_LIMIT = 1000;
export const SEARCH_MAX_LIMIT = 5000;
/** a query shorter than this (after folding) is not searched: one letter matches almost every line */
export const MIN_QUERY = 2;

const isMark = (c: string) => c >= "֑" && c <= "ׇ" && c !== "־" && c !== "׀" && c !== "׃" && c !== "׆";

const BEFORE = 30;
const AFTER = 70;

/**
 * Matches one book line (its HTML, as stored) against a FOLDED query (foldQuery). Returns null when
 * the line does not contain it.
 */
export function matchLine(html: string, folded: string, line: number): BookHit | null {
  if (!folded || !mayContain(html, folded)) return null;
  const plain = htmlToPlainText(html);
  const f = foldForSearch(plain);
  let at = f.text.indexOf(folded);
  if (at < 0) return null;
  const first = at;
  let count = 0;
  while (at >= 0) {
    count++;
    at = f.text.indexOf(folded, at + folded.length);
  }
  const start = f.map[first]!;
  let end = f.map[first + folded.length - 1]! + 1;
  // the points and accents of the last letter belong to the match (they follow the letter)
  while (end < plain.length && isMark(plain[end]!)) end++;
  return { line, count, ...snippetAround(plain, start, end) };
}

/*
 * Quick rejection, with native string operations only: most lines of a book do not match, and
 * folding each of them char by char costs ~10x more. Tags, nikud, cantillation and quote marks are
 * removed from the raw line; every word of the query must then occur in it. Nothing here can turn
 * a match into a miss: the removed chars are exactly those foldForSearch drops (tags are zero-width
 * or a space, and a space only splits words), and a line with an entity ("&quot;", "&#1488;") is
 * never rejected, because the entity decodes to something this test cannot see.
 */
const QUICK_DROP = /<[^>]*>|[\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7"'\u05f3\u05f4\u2018\u2019\u201c\u201d`\u00b4\u2033\u201e\u201f\u00ad\u200b-\u200f\u202a-\u202e\ufeff]/g;
let quickFor = "";
let quickWords: string[] = [];

function mayContain(html: string, folded: string): boolean {
  if (html.includes("&")) return true;
  if (quickFor !== folded) (quickFor = folded), (quickWords = folded.split(" ").filter(Boolean).map((w) => w.toLowerCase()));
  const raw = html.replace(QUICK_DROP, "").toLowerCase();
  return quickWords.every((w) => raw.includes(w));
}

/** A piece of `plain` around [start, end), cut at word boundaries, with "…" where it was cut. */
export function snippetAround(plain: string, start: number, end: number, before = BEFORE, after = AFTER): { snippet: string; start: number; end: number } {
  let from = Math.max(0, start - before);
  let to = Math.min(plain.length, end + after);
  if (from > 0) {
    const sp = plain.indexOf(" ", from);
    if (sp >= 0 && sp < start) from = sp + 1;
  }
  if (to < plain.length) {
    const sp = plain.lastIndexOf(" ", to);
    if (sp >= end) to = sp;
  }
  const head = from > 0 ? "…" : "";
  const tail = to < plain.length ? "…" : "";
  return { snippet: head + plain.slice(from, to) + tail, start: head.length + start - from, end: head.length + end - from };
}

/** Normalised search options: a limit within bounds. */
export function searchLimit(limit: unknown): number {
  const n = Number(limit);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), SEARCH_MAX_LIMIT) : SEARCH_LIMIT;
}

export { foldQuery };
