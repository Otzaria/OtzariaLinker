/*
 * The text layout of a links file, so a file the tool re-exports differs from the library's copy only
 * where its CONTENT changed (AGENTS.md §3: minimal diff in a library PR). Library files were written by
 * different tools:
 *   • JSON.stringify(x, null, 2), no final newline — the common case;
 *   • Python json.dump(x, indent=4) with ensure_ascii — \uXXXX escapes — and a final newline;
 *   • tabs; and one-line files: JSON.stringify(x), or Python's json.dumps(x) with ", " / ": ".
 * The layout of an imported file is detected once and reused when that book's file is written back;
 * a new file gets DEFAULT_LAYOUT. Line endings stay LF and there is no BOM: those are pipeline rules,
 * not style (LINK_FORMATS §1.8).
 */
export interface JsonLayout {
  /** one level of indentation: "  ", "    ", a tab…; "" = everything on one line */
  readonly indent: string;
  /** one-line files only: Python's default separators ", " and ": " instead of "," and ":" */
  readonly spaced?: boolean;
  readonly finalNewline: boolean;
  /** non-ASCII written as \uXXXX, with lower- or upper-case hex; false = as UTF-8 */
  readonly escapeNonAscii: "lower" | "upper" | false;
}

export const DEFAULT_LAYOUT: JsonLayout = { indent: "  ", finalNewline: false, escapeNonAscii: false };

/** \uXXXX of a character above U+007F (an escaped quote or control character does not count) */
const NON_ASCII_ESCAPE = /\\u(00[89a-fA-F][0-9a-fA-F]|0[1-9a-fA-F][0-9a-fA-F]{2}|[1-9a-fA-F][0-9a-fA-F]{3})/;

export function detectLayout(text: string): JsonLayout {
  const t = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const finalNewline = t.endsWith("\n");
  let escapeNonAscii: JsonLayout["escapeNonAscii"] = false;
  // escaped only if no raw non-ASCII character appears and some escape stands for one
  if (!/[^\x00-\x7f]/.test(t)) {
    const esc = NON_ASCII_ESCAPE.exec(t);
    if (esc) escapeNonAscii = /[A-F]/.test(esc[1]!) ? "upper" : "lower";
  }
  // "[{…" on one line
  if (/^\[\s*\{/.test(t) && !t.startsWith("[\n")) {
    const spaced = /^\[\{"(?:[^"\\]|\\.)*": /.test(t);
    return { indent: "", finalNewline, escapeNonAscii, ...(spaced && { spaced }) };
  }
  const indent = /^\[\n([ \t]+)\S/.exec(t)?.[1] ?? DEFAULT_LAYOUT.indent;
  return { indent, finalNewline, escapeNonAscii };
}

/** JSON text in a layout. Values are what JSON.stringify writes; only whitespace and escapes differ. */
export function stringifyInLayout(value: unknown, layout: JsonLayout = DEFAULT_LAYOUT): string {
  let s = JSON.stringify(value, null, layout.indent);
  if (!layout.indent && layout.spaced) s = respace(s);
  if (layout.escapeNonAscii) {
    const upper = layout.escapeNonAscii === "upper";
    // per UTF-16 code unit, like Python's ensure_ascii (astral characters become surrogate pairs)
    s = s.replace(/[\u0080-￿]/g, (c) => {
      const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
      return `\\u${upper ? hex.toUpperCase() : hex}`;
    });
  }
  return layout.finalNewline ? `${s}\n` : s;
}

/** Compact JSON → Python's default ", " / ": " separators, outside strings only. */
function respace(s: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    out += c;
    if (inString) {
      if (c === "\\") out += s[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "," || c === ":") out += " ";
  }
  return out;
}
