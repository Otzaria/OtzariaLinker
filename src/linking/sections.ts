import { normalizeTitle } from "../core/links/titles";
import { stripTags } from "../core/text/html";
import type { EngineBook } from "./automatic/types";

/*
 * The part of a book that is written on ONE of its bases. Many classic commentaries are one book on
 * several bases (the database lists them in book_base_text: חזקוני, רבנו בחיי, מדרש לקח טוב on the five
 * books of the Torah…) and divide themselves by a heading that names the base: "בראשית", "ספר שמות".
 * Running a pair engine on the whole book against one base would link the commentary on שמות א into
 * בראשית א; on the section it can only link what is written on that base.
 *
 * Pure: the max-link job calls it after reading the book (workers/maxlink-job.ts).
 */

/** Names a heading may use for a base: its title, the part after " על " ("רש"י על בראשית" → "בראשית"). */
export function sectionNames(baseTitle: string): Set<string> {
  const key = (s: string) => normalizeTitle(s).replace(/[״׳"']/g, "");
  const names = new Set([key(baseTitle)]);
  const at = baseTitle.lastIndexOf(" על ");
  if (at !== -1) names.add(key(baseTitle.slice(at + 4)));
  return names;
}

const headingKey = (html: string) =>
  normalizeTitle(stripTags(html))
    .replace(/[״׳"']/g, "")
    .replace(/^(ספר|חומש)\s+/, "")
    .replace(/[.:,;]+$/, "")
    .trim();

export interface Section {
  /** the book cut to the section: the lines AFTER each matching heading, up to the next heading of the same or a higher level */
  readonly book: EngineBook;
  /** the heading text as written */
  readonly heading: string;
  /** lines in the section */
  readonly lines: number;
}

/**
 * The section of `book` headed by `baseTitle`, or null when no heading names it. When several
 * headings name it, the highest level wins (a "בראשית" part beats a "בראשית" parsha inside it), and
 * every heading at that level contributes (a book may come back to a base later).
 */
export function sectionFor(book: EngineBook, baseTitle: string): Section | null {
  const names = sectionNames(baseTitle);
  const lines = book.lines;
  const hits: number[] = [];
  let level = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    // the title heading (level 1, the book's own name) is never a section
    if (l.heading === null || l.heading <= 1 || !names.has(headingKey(l.text))) continue;
    if (l.heading < level) (level = l.heading), (hits.length = 0);
    if (l.heading === level) hits.push(i);
  }
  if (!hits.length) return null;
  const picked: EngineBook["lines"][number][] = [];
  for (const start of hits) {
    for (let j = start + 1; j < lines.length; j++) {
      const x = lines[j]!;
      if (x.heading !== null && x.heading <= level) break;
      picked.push(x);
    }
  }
  return { book: { book: book.book, lines: picked }, heading: stripTags(lines[hits[0]!]!.text).trim(), lines: picked.length };
}
