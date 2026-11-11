/**
 * Heading level 1–6 of a book line, or null — exact port of the generator's detectHeaderLevel
 * (Generator.kt:1663): the line must START with "<h1".."<h6" (case-insensitive). A leading space or
 * another tag before it makes it an ordinary line (v3 matched "<hN" anywhere and wrongly blocked
 * links on such lines). The generator drops links whose either end is a heading line, and does not
 * create a line at all for a heading whose text is empty.
 */
export function headingLevel(content: unknown): number | null {
  const m = /^<h([1-6])/i.exec(String(content ?? ""));
  return m ? parseInt(m[1]!, 10) : null;
}

export const isHeading = (content: unknown): boolean => headingLevel(content) != null;

/** Removes tags and decodes the common entities. For display/search only — never for offsets. */
export function stripTags(html: unknown): string {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}
