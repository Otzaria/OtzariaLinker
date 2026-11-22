import { stripTags } from "../../core/text/html";
import { checkCustomPattern } from "../../core/text/safe-regex";
import type { EngineBook, EngineLine } from "./types";

/*
 * Which lines of the SOURCE book enter an engine, and how the marker in front of them is read (issue #27: "link by the dibur hamatchil,
 * but only the lines that start with [א]"). One general mechanism in four stages, none of them an engine:
 *   (a) eligibility   a line enters the engine when its start matches the prefix (mode "include", the default) or when it does not
 *                     ("exclude"): the prefix is a preset ("[א]", "(א)", "א)", a bold "ד"ה" label) or a regular expression of the user's;
 *   (b) preprocessing for MATCHING ONLY the prefix is replaced by as many spaces as it has characters (`strip`), so that the words after it
 *                     are what the engine reads, and every raw offset in the line is still the original's;
 *   (c) matching      the engine of the user's choice, unchanged (dibur-hamatchil, headings, notes, pattern);
 *   (d) output        the line, the anchor and the matched words of a suggestion are those of the ORIGINAL line, because they were never computed
 *                     on another string: the line the engine reads has the same index and the same length.
 * Lines that are not eligible are empty for the engine (the index stays, so every line number is the original's); headings are kept, they
 * are the structure the engines read the book by. Nothing here reads a database or changes state.
 *
 * ReDoS: the presets are fixed and bounded; a regular expression of the user's goes through checkCustomPattern (safe-regex.ts: no nested
 * quantifiers, no back-references, bounded quantifiers, never empty), is anchored at the start of the line, and is only ever run on the
 * first PREFIX_WINDOW characters of a line, so a hostile line costs the same as a short one.
 */

export type SourceFilterPreset = "square" | "round" | "close-paren" | "bold-dh";
export const SOURCE_FILTER_PRESETS: readonly SourceFilterPreset[] = ["square", "round", "close-paren", "bold-dh"];

export interface SourceFilter {
  readonly prefix: { readonly preset: SourceFilterPreset } | { readonly regex: string };
  /** "include" (default): only the lines that start with the prefix; "exclude": every line except those */
  readonly mode?: "include" | "exclude";
  /**
   * Read the words AFTER the prefix (the prefix is replaced by spaces of the same length). Default: yes for dibur-hamatchil, which quotes
   * the base by those words; no for the other engines (the headings engine reads "(יב)" at the start of a line as a number).
   */
  readonly strip?: boolean;
}

/** How much of a line is looked at: a marker is short, and the rest of a long line must cost nothing. */
export const PREFIX_WINDOW = 400;

const LEAD = String.raw`(?:\s|&nbsp;|<[^>]{0,60}>){0,8}`;
const LABEL = String.raw`[א-ת\d"'״׳.]{1,6}`;
const PRESET_SOURCE: Readonly<Record<SourceFilterPreset, string>> = {
  square: String.raw`\[\s*${LABEL}\s*\]`,
  round: String.raw`\(\s*${LABEL}\s*\)`,
  "close-paren": String.raw`${LABEL}\)`,
  // a bold label that only says "ד"ה", with nothing else inside it; no tag may come before it (the tag IS the marker)
  "bold-dh": String.raw`<(?:b|strong)>\s*[בו]?(?:ד"ה|ד״ה|דה|דיבור המתחיל)\s*[.:]?\s*</(?:b|strong)>`,
};
/** after the prefix: closing tags and spaces that belonged to it ("<b>[א]</b> text") */
const AFTER = /^(?:\s|&nbsp;|<\/[a-zA-Z0-9]{1,10}>){0,10}/;

export interface PrefixMatch {
  /** where the prefix ends */
  readonly prefixEnd: number;
  /** where the words the engine should read start: past the prefix, its closing tags and the spaces after it */
  readonly matchFrom: number;
}

export interface CompiledSourceFilter {
  readonly spec: SourceFilter;
  readonly mode: "include" | "exclude";
  readonly strip: boolean;
  /** the prefix of a line, or null when the line does not start with it */
  match(text: string): PrefixMatch | null;
}

export type CompileResult = { readonly ok: true; readonly filter: CompiledSourceFilter } | { readonly ok: false; readonly reason: string };

/** The leading `^` a user may write is the anchor we add anyway. */
const withoutAnchor = (p: string) => (p.startsWith("^") ? p.slice(1) : p);

export function compileSourceFilter(spec: SourceFilter, defaults: { readonly strip?: boolean } = {}): CompileResult {
  let re: RegExp;
  const lead = "preset" in spec.prefix ? (spec.prefix.preset === "bold-dh" ? String.raw`\s*` : LEAD) : LEAD;
  if ("preset" in spec.prefix) {
    if (!SOURCE_FILTER_PRESETS.includes(spec.prefix.preset)) return { ok: false, reason: "הסימן שבחרתם בתחילת השורה אינו מוכר." };
    re = new RegExp(`^${lead}${PRESET_SOURCE[spec.prefix.preset]}`, "u");
  } else {
    const check = checkCustomPattern(withoutAnchor(spec.prefix.regex));
    if (!check.ok) return { ok: false, reason: check.reason };
    // the guard returned the pattern with its quantifiers bounded; it must match at the start of the line (after tags and spaces)
    re = new RegExp(`^${lead}(?:${check.regex.source})`, check.regex.flags.replace("g", ""));
  }
  const mode = spec.mode ?? "include";
  const strip = spec.strip ?? defaults.strip ?? false;
  return {
    ok: true,
    filter: {
      spec,
      mode,
      strip,
      match(text: string): PrefixMatch | null {
        const head = text.length > PREFIX_WINDOW ? text.slice(0, PREFIX_WINDOW) : text;
        const m = re.exec(head);
        if (!m) return null;
        const prefixEnd = m[0].length;
        return { prefixEnd, matchFrom: prefixEnd + AFTER.exec(head.slice(prefixEnd))![0].length };
      },
    },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A filter as it may arrive from a stored job or a form: only a known preset or a string regex, a known mode, a boolean strip. The regular
 * expression is NOT checked here (compileSourceFilter does that); null when the shape is wrong.
 */
export function parseSourceFilter(raw: unknown): SourceFilter | null {
  if (!isRecord(raw) || !isRecord(raw["prefix"])) return null;
  const p = raw["prefix"];
  let prefix: SourceFilter["prefix"];
  if (typeof p["preset"] === "string") {
    if (!SOURCE_FILTER_PRESETS.includes(p["preset"] as SourceFilterPreset)) return null;
    prefix = { preset: p["preset"] as SourceFilterPreset };
  } else if (typeof p["regex"] === "string") prefix = { regex: p["regex"] };
  else return null;
  const mode = raw["mode"];
  if (mode !== undefined && mode !== "include" && mode !== "exclude") return null;
  const strip = raw["strip"];
  if (strip !== undefined && typeof strip !== "boolean") return null;
  return { prefix, ...(mode !== undefined && { mode }), ...(strip !== undefined && { strip }) };
}

/** True when the line enters the engine: a content line that has the prefix (include) or lacks it (exclude). Headings and blank lines are not judged. */
const judged = (l: EngineLine) => l.heading === null && stripTags(l.text).trim() !== "";

/**
 * The book as the engine reads it: the same lines at the same indexes. An ineligible content line is empty; an eligible one has its prefix
 * replaced by spaces when the filter strips (every character, tags included, so no offset moves). The input is not changed.
 */
export function applySourceFilter(book: EngineBook, filter: CompiledSourceFilter): EngineBook {
  const lines = book.lines.map((l): EngineLine => {
    if (!judged(l)) return l;
    const m = filter.match(l.text);
    const eligible = (m !== null) === (filter.mode === "include");
    if (!eligible) return { ...l, text: "" };
    if (m === null || !filter.strip || filter.mode === "exclude") return l;
    return { ...l, text: " ".repeat(m.matchFrom) + l.text.slice(m.matchFrom) };
  });
  return { ...book, lines };
}

export interface SourceFilterPreview {
  /** content lines judged (not headings, not blank) */
  readonly total: number;
  readonly included: number;
  readonly excluded: number;
  readonly headings: number;
  readonly blank: number;
  /** the first lines that enter: the prefix as the reader sees it, and the words that will be matched */
  readonly includedSample: readonly { readonly line: number; readonly prefix: string; readonly rest: string }[];
  /** the first lines that do not */
  readonly excludedSample: readonly { readonly line: number; readonly text: string }[];
}

const SNIPPET = 60;
const snippet = (html: string) => stripTags(html).replace(/\s+/g, " ").trim().slice(0, SNIPPET);

/** Which lines would enter, and which would not, with a few of each (line numbers are 0-based, the original's). */
export function previewSourceFilter(lines: readonly EngineLine[], filter: CompiledSourceFilter, limit = 6): SourceFilterPreview {
  let included = 0;
  let excluded = 0;
  let headings = 0;
  let blank = 0;
  const includedSample: { line: number; prefix: string; rest: string }[] = [];
  const excludedSample: { line: number; text: string }[] = [];
  for (const l of lines) {
    if (l.heading !== null) {
      headings++;
      continue;
    }
    if (stripTags(l.text).trim() === "") {
      blank++;
      continue;
    }
    const m = filter.match(l.text);
    if ((m !== null) === (filter.mode === "include")) {
      included++;
      if (includedSample.length < limit) includedSample.push({ line: l.index, prefix: m ? stripTags(l.text.slice(0, m.prefixEnd)).trim() : "", rest: snippet(l.text.slice(m && filter.mode === "include" ? m.matchFrom : 0)) });
    } else {
      excluded++;
      if (excludedSample.length < limit) excludedSample.push({ line: l.index, text: snippet(l.text) });
    }
  }
  return { total: included + excluded, included, excluded, headings, blank, includedSample, excludedSample };
}
