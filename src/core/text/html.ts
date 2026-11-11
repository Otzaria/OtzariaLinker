/** Heading level 1–6 of a book line, or null. The Otzaria generator skips links whose end is a heading line. */
export function headingLevel(content: unknown): number | null {
  const m = String(content ?? "").match(/<h([1-6])\b/i);
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
