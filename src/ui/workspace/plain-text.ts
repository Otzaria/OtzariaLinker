import { sanitizeBookHtml } from "../../core/text/sanitize";

/**
 * A book line as plain text for snippets: tags removed AND entities decoded (stripTags leaves
 * "&thinsp;" as is — UX review #10). The HTML is sanitized first, so parsing it is safe.
 */
export function plainText(html: string): string {
  const t = document.createElement("template");
  t.innerHTML = sanitizeBookHtml(html);
  return (t.content.textContent ?? "").replace(/\s+/g, " ").trim();
}
