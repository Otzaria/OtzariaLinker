/*
 * The text layout of a links file, so a file the tool re-exports differs from the library's copy only
 * where its CONTENT changed (AGENTS.md §3: minimal diff in a library PR). Library files were written by
 * different tools:
 *   • JSON.stringify(x, null, 2), no final newline — the common case;
 *   • Python json.dump(x, indent=4) with ensure_ascii — \uXXXX escapes — and a final newline;
 *   • tabs; and one-line files: JSON.stringify(x), or Python's json.dumps(x) with ", " / ": ";
 *   • Python with float line numbers: `"line_index_1": 126.0` (352 library files; review C9).
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
  /**
   * Numeric keys whose every value in the file is written as a float, `126.0` (Python json.dump of
   * floats): integer values of these keys are written the same way. A file that mixes `126.0` and
   * `126` for a key does not list it — its records keep their own text instead (convert.ts).
   */
  readonly floatKeys?: readonly string[];
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
  const floatKeys = detectFloatKeys(t);
  const floats = floatKeys.length ? { floatKeys } : {};
  // "[{…" on one line
  if (/^\[\s*\{/.test(t) && !t.startsWith("[\n")) {
    const spaced = /^\[\{"(?:[^"\\]|\\.)*": /.test(t);
    return { indent: "", finalNewline, escapeNonAscii, ...(spaced && { spaced }), ...floats };
  }
  const indent = /^\[\n([ \t]+)\S/.exec(t)?.[1] ?? DEFAULT_LAYOUT.indent;
  return { indent, finalNewline, escapeNonAscii, ...floats };
}

/** The numeric fields of a record — the only keys whose number spelling the layout keeps. */
export const NUMERIC_KEYS: readonly string[] = ["line_index_1", "line_index_1_end", "line_index_2", "line_index_2_end", "start", "end"];

/**
 * A key's number token. A `"key":` inside a string value is escaped (`\"key\":`), so it never matches.
 * Only plain keys are listed, so the alternation needs no escaping.
 */
const NUMBER_OF = new RegExp(`"(${NUMERIC_KEYS.join("|")})"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)`, "g");

function detectFloatKeys(t: string): string[] {
  if (!/":\s*-?\d+\./.test(t)) return []; // no number with a fraction at all: one fast scan, no matches built
  const seen = new Map<string, boolean>(); // key → every value so far is written "N.0"
  for (const m of t.matchAll(NUMBER_OF)) seen.set(m[1]!, (seen.get(m[1]!) ?? true) && /^-?\d+\.0$/.test(m[2]!));
  return NUMERIC_KEYS.filter((k) => seen.get(k) === true);
}

/**
 * Whether the writer, in this layout, might spell part of `text` (a record, or a whole file) otherwise:
 *   - a number with a fraction or an exponent, except N.0 of a float key (126.0 → 126);
 *   - an escape JSON.stringify does not write: \/, any \u in a file of raw UTF-8, and in an escaped
 *     file a \u of an ASCII character or in the other hex case.
 * The escapes it does write (\" \\ \n …) are spelled alike. False means the text needs no comparison.
 */
export function mayBeSpelledOtherwise(text: string, layout: JsonLayout): boolean {
  if (text.includes("\\/")) return true;
  if (!layout.escapeNonAscii) {
    if (text.includes("\\u")) return true;
  } else if (/\\u00[0-7]/.test(text) || (layout.escapeNonAscii === "upper" ? /\\u[0-9A-F]{0,3}[a-f]/ : /\\u[0-9a-f]{0,3}[A-F]/).test(text)) return true;
  if (!/":\s*-?\d+[.eE]/.test(text)) return false;
  const floats = layout.floatKeys ?? [];
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)":\s*-?\d+([.eE][-+0-9.eE]*)?/g)) if (m[2] !== undefined && !(m[2] === ".0" && floats.includes(m[1]!))) return true;
  return false;
}

/** `"key": 126` → `"key": 126.0` for the float keys of a layout (stringify output; integers only). */
function writeFloats(s: string, keys: readonly string[]): string {
  const known = keys.filter((k) => NUMERIC_KEYS.includes(k)).join("|");
  let re = FLOATS.get(known);
  if (!re) FLOATS.set(known, (re = new RegExp(`("(?:${known})": ?)(-?\\d+)(?=[,}\\n])`, "g")));
  return known ? s.replace(re, "$1$2.0") : s;
}
const FLOATS = new Map<string, RegExp>();

/** JSON text in a layout. Values are what JSON.stringify writes; only whitespace and escapes differ. */
export function stringifyInLayout(value: unknown, layout: JsonLayout = DEFAULT_LAYOUT): string {
  let s = JSON.stringify(value, null, layout.indent);
  if (layout.floatKeys?.length) s = writeFloats(s, layout.floatKeys);
  if (!layout.indent && layout.spaced) s = respace(s);
  if (layout.escapeNonAscii) s = escapeNonAscii(s, layout.escapeNonAscii === "upper");
  return layout.finalNewline ? `${s}\n` : s;
}

/**
 * One element of a top-level array exactly as stringifyInLayout writes it inside the array (its
 * lines indented one level), without the indentation before its first line.
 */
export function stringifyElement(value: unknown, layout: JsonLayout = DEFAULT_LAYOUT): string {
  let s = JSON.stringify(value, null, layout.indent);
  if (layout.floatKeys?.length) s = writeFloats(s, layout.floatKeys);
  if (layout.indent) s = s.replaceAll("\n", `\n${layout.indent}`);
  else if (layout.spaced) s = respace(s);
  return layout.escapeNonAscii ? escapeNonAscii(s, layout.escapeNonAscii === "upper") : s;
}

/**
 * A top-level array from element texts: stringifyElement output or an element's own text kept from
 * the imported file. With stringifyElement for every element this is stringifyInLayout(array).
 */
export function joinElements(elements: readonly string[], layout: JsonLayout = DEFAULT_LAYOUT): string {
  let s: string;
  if (!elements.length) s = "[]";
  else if (layout.indent) s = `[\n${layout.indent}${elements.join(`,\n${layout.indent}`)}\n]`;
  else s = `[${elements.join(layout.spaced ? ", " : ",")}]`;
  return layout.finalNewline ? `${s}\n` : s;
}

function escapeNonAscii(s: string, upper: boolean): string {
  // per UTF-16 code unit, like Python's ensure_ascii (astral characters become surrogate pairs)
  return s.replace(/[\u0080-\uffff]/g, (c) => {
    const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${upper ? hex.toUpperCase() : hex}`;
  });
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
