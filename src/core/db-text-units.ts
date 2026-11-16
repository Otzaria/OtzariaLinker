/*
 * How the value of one database row becomes lines, for the mapping wizard's text units
 * (DbMapping.lines.unit): several lines in one cell, or JSON of lines and chapters. Pure: the
 * preview measures with the same functions the reader reads with, so the wizard's "≈ N lines per
 * row" is what opening gives.
 */

export interface UnitLine {
  text: string;
  /** 1–6 for a title taken from a JSON object; null otherwise (headings in the text are found later) */
  heading: number | null;
}

/** Lines of a text at its line breaks (\r\n, \n or \r). A final break does not start an empty line. */
export function splitLines(text: string): string[] {
  const out = text.split(/\r\n|\n|\r/);
  if (out.length > 1 && out[out.length - 1] === "") out.pop();
  return out;
}

const TITLE_KEYS = ["title", "name", "heading", "header", "he_title", "heTitle", "כותרת", "שם"];
const CONTENT_KEYS = ["text", "he", "hebrew", "content", "body", "lines", "verses", "paragraphs", "segments", "chapters", "sections", "children", "items", "טקסט", "תוכן"];
const MAX_DEPTH = 32;
const MAX_LINES = 1_000_000;

/**
 * The lines of a JSON value: strings in document order (split at line breaks); arrays in order
 * (chapters, then verses); an object contributes its title as a heading and then its content keys
 * (text, verses, chapters…), or every array it holds when it has none of them. Numbers, booleans
 * and other keys (ids, references) are left out. null when the value is not JSON, or holds no text.
 */
export function jsonLines(value: string): UnitLine[] | null {
  const t = value.trimStart();
  if (t[0] !== "[" && t[0] !== "{") return null;
  let doc: unknown;
  try {
    doc = JSON.parse(t);
  } catch {
    return null;
  }
  const out: UnitLine[] = [];
  const walk = (x: unknown, depth: number): void => {
    if (out.length >= MAX_LINES || depth > MAX_DEPTH) return;
    if (typeof x === "string") {
      for (const line of splitLines(x)) out.push({ text: line, heading: null });
    } else if (Array.isArray(x)) {
      for (const y of x) walk(y, depth + 1);
    } else if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      const titleKey = TITLE_KEYS.find((k) => typeof o[k] === "string" && (o[k] as string).trim());
      if (titleKey) out.push({ text: (o[titleKey] as string).trim(), heading: Math.min(6, 2 + Math.floor(depth / 2)) });
      const keys = Object.keys(o).filter((k) => CONTENT_KEYS.includes(k) && (typeof o[k] === "string" || Array.isArray(o[k]) || (o[k] && typeof o[k] === "object")));
      for (const k of keys.length ? keys : Object.keys(o).filter((k) => Array.isArray(o[k]))) walk(o[k], depth + 1);
    }
  };
  walk(doc, 0);
  return out.some((l) => l.text.trim()) ? out : null;
}
