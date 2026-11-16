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

/** Tags that start a new block in the browser: their place in the text is a space, not nothing. */
const BLOCK_TAG = /^\/?(br|p|div|h[1-6]|li|ul|ol|tr|td|th|table|hr|blockquote)\b/i;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", zwnj: "", zwj: "", lrm: "", rlm: "", shy: "",
  quot: "\"", apos: "'", amp: "&", lt: "<", gt: ">", hellip: "…", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", middot: "·", bull: "•",
};

/**
 * A book line as plain text, the way a reader shows it: tags removed (a line-breaking tag becomes a
 * space, an inline tag inside a word does not split it), entities decoded, runs of white space made
 * one space. A "<" with no ">" stays as text (the reader shows that rest of the line). Pure: it
 * runs in the worker (in-book search) and in the UI (snippets). Never for anchor offsets.
 */
export function htmlToPlainText(html: unknown): string {
  const s = String(html ?? "");
  // fast path, the same result: with no entity, the scan below only replaces each "<…>" (from a "<"
  // to the next ">", as this regex does) — the search calls this for every line of a book
  if (!s.includes("&")) return s.replace(/<([^>]*)>/g, (_m, tag: string) => (BLOCK_TAG.test(tag) ? " " : "")).replace(/\s+/g, " ").trim();
  let out = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i]!;
    if (c === "<") {
      const gt = s.indexOf(">", i + 1);
      if (gt >= 0) {
        if (BLOCK_TAG.test(s.slice(i + 1, gt))) out += " ";
        i = gt + 1;
        continue;
      }
    } else if (c === "&") {
      const m = /^&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(s.slice(i, i + 40));
      if (m) {
        const name = m[1]!;
        const cp = name[0] === "#" ? parseInt(name.slice(name[1] === "x" || name[1] === "X" ? 2 : 1), name[1] === "x" || name[1] === "X" ? 16 : 10) : NaN;
        out += name[0] === "#" ? (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "�") : (NAMED_ENTITIES[name.toLowerCase()] ?? "");
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Text → HTML text that is inert anywhere in element content or a quoted attribute: the five
 * characters that can open a tag, an entity or end an attribute are escaped. For reports the tool
 * writes from untrusted book text and link fields (docs/SECURITY.md); never for anchor offsets.
 */
export const escapeHtml = (text: unknown): string =>
  String(text ?? "").replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));

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
