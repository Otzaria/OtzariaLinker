import { stripTags } from "../../core/text/html";
import { checkCustomPattern } from "../../core/text/safe-regex";
import type { EngineBook, EngineLine, EngineResult, Reason, Suggestion } from "./types";

/*
 * Which lines of the SOURCE book enter an engine, and how the marker in front of them is read (issue #27: "link by the dibur hamatchil,
 * but only the lines that start with [א]"). One general mechanism in four stages, none of them an engine:
 *   (a) eligibility   a line enters the engine when its start matches the prefix (mode "include", the default) or when it does not
 *                     ("exclude"): the prefix is a preset ("[א]", "(א)", "א)", a bold "ד"ה" label) or a regular expression of the user's;
 *   (b) preprocessing for MATCHING ONLY the prefix's visible characters become spaces, one for one, its tags and entities stay (`strip`,
 *                     blankMarker), so that the words after it are what the engine reads, and every raw and visible offset in the line
 *                     is still the original's;
 *   (c) matching      the engine of the user's choice, unchanged (dibur-hamatchil, headings, notes, pattern);
 *   (d) output        the line, the anchor and the matched words of a suggestion are those of the ORIGINAL line, because they were never computed
 *                     on another string: the line the engine reads has the same index and the same length.
 * Lines that are not eligible are empty for a words engine (the index stays, so every line number is the original's) and kept for a structure
 * engine; headings are kept, they are the structure the engines read the book by. Whatever an engine proposes on a line that is not eligible
 * is dropped by the guard (LineGate, below: the filter is the RUN's, findings #40 A1). Nothing here reads a database or changes state.
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

/**
 * White space a marker may stand among: spaces (NBSP included), and the invisible marks a right-to-left text carries — LRM/RLM, zero-width
 * spaces and joiners, the embedding and isolate controls, a BOM — as characters or as entities (findings #42 C11: "‏[א]" was no marker).
 */
const GAP = String.raw`(?:[\s​-‏‪-‮⁦-⁩﻿]|&(?:nbsp|lrm|rlm|zwnj|zwj);|&#(?:160|820[3-7]|x[aA]0|x200[b-fB-F]);)`;
const LEAD = String.raw`(?:${GAP}|<[^>]{0,60}>){0,8}`;
/**
 * A label of up to six letters or digits, each letter with the nikud and cantillation marks written on it ("[אֿ]", "[בּ]": findings #42
 * C11). The marks cannot begin a label, so a letter and its marks are read one way only (no ambiguity for the regex engine).
 */
const LABEL = String.raw`(?:[א-ת\d"'״׳.][֑-ׇ]{0,4}){1,6}`;
const PRESET_SOURCE: Readonly<Record<SourceFilterPreset, string>> = {
  square: String.raw`\[${GAP}{0,4}${LABEL}${GAP}{0,4}\]`,
  round: String.raw`\(${GAP}{0,4}${LABEL}${GAP}{0,4}\)`,
  "close-paren": String.raw`${LABEL}\)`,
  // a bold label that only says "ד"ה", with nothing else inside it; no tag may come before it (the tag IS the marker)
  "bold-dh": String.raw`<(?:b|strong)>\s*[בו]?(?:ד"ה|ד״ה|דה|דיבור המתחיל)\s*[.:]?\s*</(?:b|strong)>`,
};
/** after the prefix: closing tags and spaces that belonged to it ("<b>[א]</b> text") */
const AFTER = new RegExp(String.raw`^(?:${GAP}|<\/[a-zA-Z0-9]{1,10}>){0,10}`);

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
  const lead = "preset" in spec.prefix ? (spec.prefix.preset === "bold-dh" ? String.raw`${GAP}{0,8}` : LEAD) : LEAD;
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

/**
 * The line with its marker blanked for matching (findings #41 B3): every VISIBLE character before `end` becomes a space, one for one (a
 * UTF-16 unit for a unit), while tags and entities stay exactly as they are. Blanking the tags too ("<b>[א] אלפא</b>" → spaces up to the
 * words) left a stray "</b>", lost the bold label the engine reads a dibur by, and moved every visible offset by the tag's length — the
 * generator does not count a tag (core/text/offsets.ts). Here the raw length, every raw and every visible offset, and the tags are the
 * original's. The scan follows offsets.ts: "<" opens a tag until the next ">" (with none, the rest is hidden, and so kept), "&…;" of up to
 * ten characters is one visible unit (kept whole).
 */
export function blankMarker(text: string, end: number): string {
  let out = "";
  let inTag = false;
  let i = 0;
  for (; i < end && i < text.length; i++) {
    const c = text[i]!;
    if (inTag) {
      out += c;
      if (c === ">") inTag = false;
    } else if (c === "<") {
      inTag = true;
      out += c;
    } else if (c === "&") {
      const stop = Math.min(text.length, i + 10);
      let j = i + 1;
      while (j < stop && text[j] !== ";") j++;
      if (j < stop) {
        out += text.slice(i, j + 1);
        i = j;
      } else out += " ";
    } else out += " ";
  }
  return out + text.slice(i);
}

/** True when the line enters the engine: a content line that has the prefix (include) or lacks it (exclude). Headings and blank lines are not judged. */
const judged = (l: EngineLine) => l.heading === null && stripTags(l.text).trim() !== "";

/**
 * The book as the engine reads it: the same lines at the same indexes. An ineligible content line is empty (unless `blankExcluded` is
 * false: an engine that reads the book's structure keeps it, and the gate drops what it proposes there); an eligible one has its prefix
 * blanked when the filter strips (blankMarker: its visible characters become spaces, its tags and entities stay, so no offset moves). The
 * input is not changed.
 */
export function applySourceFilter(book: EngineBook, filter: CompiledSourceFilter, blankExcluded = true): EngineBook {
  const lines = book.lines.map((l): EngineLine => {
    if (!judged(l)) return l;
    const m = filter.match(l.text);
    const eligible = (m !== null) === (filter.mode === "include");
    if (!eligible) return blankExcluded ? { ...l, text: "" } : l;
    if (m === null || !filter.strip || filter.mode === "exclude") return l;
    return { ...l, text: blankMarker(l.text, m.matchFrom) };
  });
  return { ...book, lines };
}

/*
 * The line filter of a RUN (findings #40 A1). A filter is the user's statement about the SOURCE book of the run — "only the lines that start
 * with [א]" — and not an option of one engine: a run of several methods (all methods merged, max-link, a batch, the guided flow) must obey it
 * in every one of them. The stages, each in one place:
 *   (1) permitted lines   LineGate.judge — decided once per line, on the original text (headings and blank lines are never a filtered line's
 *                         own: in "include" mode they are not permitted to carry a link, in "exclude" mode they are);
 *   (2) preparation       the same call returns the line as the engine reads it — a words engine (dibur-hamatchil, pattern) sees an
 *                         excluded line empty, so it cannot match noise; a structure engine (headings, footnotes) sees every line, because
 *                         its numbering and windows run through them, and only its suggestions are judged; citations read every line
 *                         too, because "שם" on an included line refers to what an excluded line cited (V7 PR2 review, finding 2);
 *   (3) the engines       unchanged;
 *   (4) the merge         unchanged (state/maxlink.ts, linking/merge.ts): it only combines what the engines proposed;
 *   (5) the guard         LineGate.guard — every suggestion whose line in the filtered book is not permitted is dropped, whichever engine or
 *                         path produced it (a section of the book, a commentary carried through another, notes linked by headings), and the
 *                         result says how many.
 * index.ts engineSteps runs stages 1-3 and 5 for one engine; workers/maxlink-job.ts and workers/citations-job.ts run stage 5 again on
 * every step of a job, with the run's filter.
 */
export class LineGate {
  private readonly permitted = new Set<number>();
  private readonly seen = new Set<number>();
  /** content lines judged, and how many of them entered */
  total = 0;
  included = 0;

  constructor(
    readonly bookKey: string,
    readonly filter: CompiledSourceFilter,
    /** an excluded content line is empty for the engine (words engines); false: the engine reads it as it is (structure engines) */
    private readonly blankExcluded = true,
  ) {}

  /** Stages 1 and 2: whether the line may carry a link, and the line as the engine reads it (same index, same length). */
  judge(l: EngineLine): EngineLine {
    if (this.seen.has(l.index)) return this.prepared(l, this.permitted.has(l.index));
    this.seen.add(l.index);
    if (!judged(l)) {
      if (this.filter.mode === "exclude") this.permitted.add(l.index);
      return l;
    }
    this.total++;
    const m = this.filter.match(l.text);
    const eligible = (m !== null) === (this.filter.mode === "include");
    if (eligible) {
      this.permitted.add(l.index);
      this.included++;
    }
    return this.prepared(l, eligible, m);
  }

  private prepared(l: EngineLine, eligible: boolean, m: PrefixMatch | null = this.filter.match(l.text)): EngineLine {
    if (!judged(l)) return l;
    if (!eligible) return this.blankExcluded ? { ...l, text: "" } : l;
    if (m === null || !this.filter.strip || this.filter.mode === "exclude") return l;
    return { ...l, text: blankMarker(l.text, m.matchFrom) };
  }

  /** The whole book through stages 1 and 2. */
  book(book: EngineBook): EngineBook {
    return { ...book, lines: book.lines.map((l) => this.judge(l)) };
  }

  /** May this line of the filtered book carry a link (a line never judged is not permitted in "include" mode). */
  allows(line: number): boolean {
    return this.permitted.has(line) || (this.filter.mode === "exclude" && !this.seen.has(line));
  }

  /** The line of a suggestion in the filtered book (the record may run the other way: dibur-hamatchil writes base → commentary); null when neither side is it. */
  lineOf(s: Suggestion): number | null {
    return s.source.book.key === this.bookKey ? s.source.line : s.target.book.key === this.bookKey ? s.target.line : null;
  }

  /** Stage 5: drops every suggestion (and unmatched line) of a line the filter does not permit, and says how many. */
  guard(r: EngineResult): EngineResult {
    const kept = r.suggestions.filter((s) => {
      const line = this.lineOf(s);
      return line === null || this.allows(line);
    });
    const dropped = r.suggestions.length - kept.length;
    const unmatched = r.unmatched.filter((u) => this.allows(u.line));
    if (!dropped && unmatched.length === r.unmatched.length) return r;
    const notes = dropped ? [{ code: "source-filter/guard", text: `${dropped.toLocaleString("he")} הצעות לשורות שסינון השורות אינו כולל הוסרו.` }, ...r.notes] : r.notes;
    return { suggestions: kept, notes, unmatched };
  }

  /** The note a run with a filter starts with. */
  note(): Reason {
    return {
      code: "source-filter/applied",
      text: `סינון שורות המקור: ${this.included.toLocaleString("he")} מתוך ${this.total.toLocaleString("he")} שורות נכנסו לשיטה (${this.filter.mode === "include" ? "רק שורות שמתחילות בסימן" : "כל השורות פרט לאלה שמתחילות בסימן"}); הקישור והעוגן נשארים על השורה המקורית.${this.filter.strip ? " הסימן עצמו לא נחשב בהתאמה." : ""}`,
    };
  }
}

/** The engine option that carries a filter, and the run setting that holds it (MaxLinkRunOptions.lineFilter, JobRecord.lineFilter). */
export const SOURCE_FILTER_OPTION = "sourceFilter";

/** A filter compiled for an engine (its strip default: dibur-hamatchil reads the words after the marker); throws a coded error when invalid. */
export function compileForEngine(raw: unknown, engine: string): CompiledSourceFilter {
  const spec = parseSourceFilter(raw);
  if (!spec) throw Object.assign(new Error("הגדרת סינון השורות אינה תקינה: צריך סימן מוכר או ביטוי רגולרי."), { code: "source-filter/invalid" });
  const compiled = compileSourceFilter(spec, { strip: engine === "dibur-hamatchil" });
  if (!compiled.ok) throw Object.assign(new Error(compiled.reason), { code: "source-filter/invalid" });
  return compiled.filter;
}

const sameFilter = (a: SourceFilter, b: SourceFilter) => JSON.stringify([a.prefix, a.mode ?? "include", a.strip ?? null]) === JSON.stringify([b.prefix, b.mode ?? "include", b.strip ?? null]);

/**
 * The run's ONE filter, out of the options the forms send per engine (a form shows the filter of the engine it shows, and puts it under that
 * engine): the filter is lifted out of every engine's options and becomes the run's. An explicit run filter wins; two engines with different
 * filters are a conflict the user must settle (one run, one statement about which lines it links).
 */
export function runLineFilter(
  engineOptions: Readonly<Partial<Record<string, Record<string, unknown>>>> | undefined,
  explicit?: SourceFilter | null,
): { ok: true; filter: SourceFilter | null; engineOptions: Partial<Record<string, Record<string, unknown>>> } | { ok: false; reason: string } {
  const rest: Partial<Record<string, Record<string, unknown>>> = {};
  let found: SourceFilter | null = null;
  for (const [engine, options] of Object.entries(engineOptions ?? {})) {
    if (!options) continue;
    const { [SOURCE_FILTER_OPTION]: raw, ...others } = options;
    if (Object.keys(others).length) rest[engine] = others;
    if (raw === undefined) continue;
    const spec = parseSourceFilter(raw);
    if (!spec || !compileSourceFilter(spec).ok) return { ok: false, reason: "הגדרת סינון השורות אינה תקינה: צריך סימן מוכר או ביטוי רגולרי." };
    if (found && !sameFilter(found, spec)) return { ok: false, reason: "בחרתם סינון שורות שונה בשתי שיטות. הסינון חל על כל ההרצה: השאירו אותו בשיטה אחת, או בחרו אותו סימן בשתיהן." };
    found = spec;
  }
  if (explicit) {
    const spec = parseSourceFilter(explicit);
    if (!spec || !compileSourceFilter(spec).ok) return { ok: false, reason: "הגדרת סינון השורות אינה תקינה: צריך סימן מוכר או ביטוי רגולרי." };
    found = spec;
  }
  return { ok: true, filter: found, engineOptions: rest };
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
