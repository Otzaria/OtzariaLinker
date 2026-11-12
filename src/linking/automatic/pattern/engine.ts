import { parseConnectionType } from "../../../core/links/connection-type";
import type { BookRef, LinkSide, RawAnchor } from "../../../core/links/model";
import { storedForm } from "../../../core/links/stored-form";
import { anchorLabelFromHeRef, withAnchorLabel } from "../../../core/text/anchor-label";
import { parseNumberToken, toGematria } from "../../../core/text/gematria";
import { stripTags } from "../../../core/text/html";
import { normalize, stripNikud } from "../../../core/text/hebrew";
import { MAX_CUSTOM_REGEX_INPUT } from "../../../core/text/safe-regex";
import { visibleMap } from "../../../core/text/visible-map";
import { detectMarkers } from "../footnotes/markers";
import { dafElement, kindOfWord, kindWord, parseHeading, type PathElement } from "../headings/numbering";
import { analyzeBook } from "../headings/structure";
import { confidenceOf, DEFAULT_THRESHOLDS, type Candidate, type ConfidenceThresholds, type EngineBook, type EngineContext, type EngineResult, type Reason, type Suggestion } from "../types";
import { parseAmud, parseRefNumeral } from "./numerals";
import { bookMatches, otherBook } from "./books";
import { DEFAULT_PRESET, presetById, type PatternPreset } from "./presets";
import { compilePattern, type GroupSpec } from "./template";
import { TargetTree, type RefPath } from "./tree";

/*
 * The pattern engine — v3's "לפי תבנית" (FEATURE_INVENTORY F-100/F-101, buildRegex/resolveTargets),
 * rebuilt as a suggestion engine and grown into a STRUCTURE-REFERENCE toolkit. In every source line a
 * pattern finds references; each reference is read either as a single NUMBER (v3) or as a PATH of
 * structure levels ("סימן ה סעיף ג ס"ק ב" → סימן 5 › סעיף 3 › ס"ק 2), and says where to link:
 *
 *   target "tree"          the path names a place in the target's heading tree (tagged headings,
 *                          untagged heading lines, "(ג)" numbered lines); the link goes to the first
 *                          line there (or the section / the range "סעיף ג-ה")        — pattern/tree.ts
 *   target "line"          the number is a line number of the target book (1-based)        — v3 default
 *   target "chapter-line"  the number is the N-th text line of the current chapter of the target;
 *                          a number that is not larger than the previous one moves to the next chapter
 *   target "heading"       kept as a name of "tree" (the earlier single-level form)
 *
 * The pattern is a PRESET (pattern/presets.ts: דף ועמוד, פרק ומשנה, סימן/סעיף/ס"ק…, data with
 * documented examples) or the user's own TEMPLATE, whose placeholders say what each number is
 * (pattern/template.ts). Instead of a pattern the number may be the content of a TAG (v3's "לפי
 * תגיות", F-099: by default `<sup>`), read with the footnotes engine's marker reader.
 *
 * Changed from v3, on purpose:
 *   • The pattern runs on the VISIBLE text (tags hidden, entities one unit) and the anchor is mapped
 *     back to raw offsets with the generator's rules (v3 wrote stripped offsets as raw — TD-H4).
 *   • The pattern goes through the same guard as every user pattern (core/text/safe-regex.ts).
 *   • Numerals are canonical ("סעיף זה" is not 12); everyday-word numerals ("פרק לא") are never certain.
 *   • Heading lines are never an end of a suggestion: Otzaria skips such links (export/heading-line).
 *   • Every suggestion says why, and problems are reported per line instead of a flat list.
 */

/**
 * v3's default, `(?:דף|עמוד|סימן)\s+([א-ת]+|\d+)`, with its quantifiers bounded so the
 * user-pattern guard accepts it — now the "v3" preset.
 */
export const DEFAULT_PATTERN = "(?:דף|עמוד|סימן)\\s{1,3}([א-ת׳״'\"]{1,6}|\\d{1,4})";

export type PatternTarget = "tree" | "line" | "chapter-line" | "heading";

export interface PatternOptions {
  /** a preset of pattern/presets.ts. Default "general". Ignored when `regex` or `tag` is given. */
  readonly preset?: string;
  /** the user's own pattern: a template with placeholders, or a plain regex (see checkCustomPattern) */
  readonly regex?: string;
  /** read the number from the content of this tag instead of a pattern (v3 "לפי תגיות"), e.g. "sup" */
  readonly tag?: string;
  /** i, m, s, u only */
  readonly flags?: string;
  /** read Hebrew numerals ("יב") as numbers. Default true. */
  readonly gematria?: boolean;
  /** "first": the first match of a line only (v3). "all": every match. Default: the preset's. */
  readonly matches?: "first" | "all";
  /** where the reference points. Default: the preset's ("tree"); a plain regex or a tag: "line". */
  readonly target?: PatternTarget;
  /** tree: link to the whole section under the place as a range. Default false. */
  readonly sectionRanges?: boolean;
  /** tree: a reference right after the name of another book ("הט"ז ס"ק ג", "שבת דף כג") is skipped. Default true. */
  readonly otherBooks?: boolean;
  /** tree: a reference without its upper levels takes them from the source line's headings. Default true. */
  readonly context?: boolean;
  /**
   * "start": only a reference at the START of a line counts (after a bracket, a tag or a book's name:
   * "<b>ס"ק ג</b> …", "(ס"ק ו) …", "מ"א ס"ק ב …") — a commentary whose every comment opens with its
   * place. Default "anywhere".
   */
  readonly position?: "anywhere" | "start";
  /** lines with no reference of their own take the last reference above them, until the next heading. Default false. */
  readonly carry?: boolean;
  /** "Conection Type" of the suggestions. Default "reference" (v3's default for this method). */
  readonly declaredType?: string;
  /** "auto" (default): an anchor on the matched words when Otzaria keeps it; "off": none */
  readonly anchors?: "auto" | "off";
  readonly thresholds?: ConfidenceThresholds;
}

const ENGINE = "pattern";
const PROGRESS_EVERY = 500;
const SCORE = { exact: 1, reset: 0.9, ambiguous: 0.9 } as const;
/** a line that only continues the reference above it */
const CARRY_CAP = 0.9;
const MAX_RANGE = 40;
/** visible characters from a named reference on that are matched against the target's heading names */
const NAME_WINDOW = 60;
/** "שם" / "ושם" right before a reference: ibid */
const IBID_RE = /(?:^|[^א-ת])ו?שם\s*$/;
/** words that bring a list of references back to the book itself: "ולקמן", "לעיל", "במכילתין" */
const BACK_HOME_RE = /(?:^|[^א-ת])[ובד]?(?:לעיל|לקמן|להלן|בסמוך|כאן|מכילתין|מסכתין|בפרקין|פרקין|דידן|ע"ל|עיין לעיל)(?:[^א-ת]|$)/;
/** visible characters before a reference searched for the name of another book */
const BEFORE_WINDOW = 50;
const AFTER_WINDOW = 30;

const r = (code: string, text: string): Reason => ({ code, text });

interface Match {
  /** position of the line in source.lines */
  readonly pos: number;
  readonly line: number;
  /** the number, for the line/chapter-line targets */
  readonly num: number;
  /** the whole match, as the reader sees it */
  readonly shown: string;
  /** the number as written */
  readonly token: string;
  readonly rawStart: number;
  readonly rawEnd: number;
  /** visible offsets of the match, for chaining */
  readonly vStart: number;
  readonly vEnd: number;
  /** the structure path the match reads; for a v3 regex, the single element parseHeading finds */
  readonly ref: RefPath;
  /** an unresolved heading name ("פרשת נח") and where in the path it goes */
  readonly name?: { readonly text: string; readonly label: string; readonly at: number };
  /** a book named in the reference ("ברכות", "ב"ק") */
  readonly book?: string;
  /** a numeral that is also an everyday word ("פרק לא") */
  readonly ambiguous: boolean;
  /** the visible text right before the match, for the "another book" guard (books.ts) */
  readonly before?: string;
  /** the visible text right after the match */
  readonly after?: string;
}

type Placed = { readonly target: LinkSide; readonly score: number; readonly reasons: Reason[]; readonly warnings: Reason[]; readonly alternatives: Candidate[]; readonly rules: string[] };
type Unplaced = { readonly unplaced: Reason };

export function runPatternEngine(source: EngineBook, target: EngineBook, options: PatternOptions = {}, ctx: EngineContext = {}): EngineResult {
  const tag = options.tag?.replace(/[^a-zA-Z0-9:_-]/g, "") ?? "";
  const custom = options.regex?.trim() || "";
  const preset: PatternPreset | undefined = custom || tag ? undefined : presetById(options.preset ?? DEFAULT_PRESET);
  const notes: Reason[] = [];
  if (!tag && !custom && !preset) return { suggestions: [], notes: [r("pattern/unknown-preset", `אין תבנית מוכנה בשם "${options.preset}". בחרו תבנית מהרשימה.`)], unmatched: [] };
  const template = custom || preset?.template || DEFAULT_PATTERN;
  const compiled = tag ? null : compilePattern(template, options.flags ?? "");
  if (compiled && !compiled.ok) return { suggestions: [], notes: [r("pattern/invalid", `התבנית לא הורצה: ${compiled.reason}`)], unmatched: [] };
  const groups = compiled?.ok ? compiled.groups : [];
  const structured = groups.some((g) => g.spec.role !== "n");
  const mode: PatternTarget = normalizeMode(options.target ?? (preset ? preset.target : structured ? "tree" : "line"));
  const all = (options.matches ?? (preset ? preset.matches : structured ? "all" : "first")) === "all";
  const declaredType = options.declaredType?.trim() || "reference";
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const unmatched: { line: number; reasons: Reason[] }[] = [];

  const stats = { notNumbers: 0, samples: [] as string[] };
  const finder: Finder = compiled?.ok
    ? structured
      ? templateFinder(compiled.regex, groups, all, preset?.chain === true, stats)
      : regexFinder(compiled.regex, options, all)
    : tagFinder(tag, options, all);
  const atStart = options.position === "start";
  const found = findMatches(source, atStart ? startOnly(finder) : finder, ctx, unmatched);
  if (found === null) return { suggestions: [], notes: [r("pattern/aborted", "הריצה בוטלה לפני שהסתיימה. לא נוצרו הצעות.")], unmatched: [] };
  if (preset) notes.push(r("pattern/preset", `התבנית "${preset.name}": ${preset.description}.`));
  if (!found.length) notes.push(r("pattern/no-matches", tag ? `בספר המקור אין אף תגית <${tag}> עם מספר.` : "התבנית לא נמצאה באף שורה של ספר המקור."));
  if (stats.notNumbers)
    notes.push(r("pattern/not-numbers", `${stats.notNumbers} מקומות נראו כמו הפניה אבל המילה שאחרי מילת הסוג אינה מספר (למשל "${stats.samples.join('", "')}"), ולכן לא נקראו.`));

  const place = placer(mode, source, target, options, notes, found);
  const heRefOf = heRefIndex(target);
  const anchors = anchorDecision(source.book, target.book, declaredType, options.anchors ?? "auto");
  notes.push(anchors.reason);

  const suggestions: Suggestion[] = [];
  const perTarget = new Map<number, number>();
  for (const m of found) {
    const p = place(m);
    if ("unplaced" in p) {
      unmatched.push({ line: m.line, reasons: [p.unplaced] });
      continue;
    }
    perTarget.set(p.target.line, (perTarget.get(p.target.line) ?? 0) + 1);
    // the number as a label only when the link reads like a note ("אות יב"); a reference keeps its plain heRef
    const label = mode === "chapter-line" ? toGematria(m.num) : null;
    const heRef2 = withAnchorLabel(heRefOf(p.target.line), label);
    const keepLabel = label !== null && anchorLabelFromHeRef(heRef2) === label;
    const anchor: RawAnchor | undefined = anchors.allowed ? { rawStart: m.rawStart, rawEnd: m.rawEnd, ...(keepLabel ? { label } : {}) } : undefined;
    const runnerUp = p.alternatives.length ? p.alternatives[0]!.score : null;
    const read = mode === "line" || mode === "chapter-line" ? `והמספר ${m.token} נקרא כ־${m.num}` : `ונקרא כ־${refLabel(m)}`;
    suggestions.push({
      id: `${ENGINE}:${source.book.key}#${m.line}@${m.rawStart}>${target.book.key}#${p.target.line}${p.target.end !== undefined ? `-${p.target.end}` : ""}`,
      engine: ENGINE,
      source: { book: source.book, line: m.line },
      ...(anchor ? { anchor } : {}),
      target: p.target,
      declaredType,
      heRef2,
      score: p.score,
      confidence: confidenceOf(p.score, runnerUp, thresholds),
      reasons: [r("pattern/match", `בשורה נמצא "${m.shown.trim()}", ${read}.`), ...p.reasons],
      rules: [`pattern.${mode}`, ...(preset ? [`pattern.preset.${preset.id}`] : []), ...p.rules],
      alternatives: p.alternatives,
      warnings: p.warnings,
    });
  }
  if (options.carry) {
    const carried = carryForward(source, suggestions, thresholds);
    if (carried.length) notes.push(r("pattern/carried", `${carried.length} שורות בלי הפניה משלהן קיבלו את המקום של ההפניה האחרונה שמעליהן (עד הכותרת הבאה).`));
    suggestions.push(...carried);
    suggestions.sort((a, b) => a.source.line - b.source.line);
  }
  const shared = [...perTarget.values()].filter((n) => n > 1).length;
  if (shared) notes.push(r("pattern/shared-targets", `${shared} שורות ביעד מקבלות יותר מהפניה אחת. זה תקין בהפניות, אבל בהערות שוליים זה סימן לטעות בתבנית או בחלוקה לפרקים.`));
  return { suggestions, notes, unmatched };
}

const normalizeMode = (m: PatternTarget): PatternTarget => (m === "heading" ? "tree" : m);

/**
 * What a preset (or a template) reads in one line, as labels: "סימן ה › סעיף ג", "ס"ק א-ג",
 * "ברכות › דף ב.". For the presets' documented examples (tests) and the UI's preview; `targetTitle`
 * turns on the "another tractate" guard of the presets that have it.
 */
export function readReferences(text: string, presetOrTemplate: string, targetTitle = ""): string[] {
  const preset = presetById(presetOrTemplate);
  const compiled = compilePattern(preset?.template ?? presetOrTemplate);
  if (!compiled.ok) return [];
  const finder = templateFinder(compiled.regex, compiled.groups, true, preset?.chain === true, { notNumbers: 0, samples: [] });
  return finder(text, 0, 0).flatMap((m) =>
    "reason" in m || (targetTitle && (otherBook(m.before ?? "", m.after ?? "", targetTitle) || (m.book !== undefined && !bookMatches(m.book, targetTitle)))) ? [] : [refLabel(m)],
  );
}

/** "סימן ה › סעיף ג-ה" */
function refLabel(m: Match): string {
  const els = m.ref.elements.map((e) => e.label);
  if (m.name) els.splice(m.name.at, 0, m.name.label);
  const last = m.ref.elements[m.ref.elements.length - 1];
  let s = els.join(" › ");
  if (m.ref.to !== undefined && last) s += `-${toGematria(m.ref.to)}`;
  return (m.book ? `${m.book} › ` : "") + s;
}

/** One line → its matches (or the reason one is not a number). */
type Finder = (text: string, line: number, pos: number) => (Match | { readonly line: number; readonly reason: Reason })[];

/** A v3-style regex: the number is group `n` or group 1; the match itself may say what it is ("סימן יב"). */
function regexFinder(regex: RegExp, options: PatternOptions, all: boolean): Finder {
  const gematria = options.gematria !== false;
  return (text, line, pos) => {
    const out: (Match | { line: number; reason: Reason })[] = [];
    const map = visibleMap(text);
    regex.lastIndex = 0;
    for (const m of map.text.matchAll(regex)) {
      if (!m[0].length) continue;
      const token = (m.groups?.["n"] ?? m[1] ?? "").trim();
      const num = token ? parseNumberToken(token.replace(/['"׳״]/g, ""), gematria) : null;
      if (num === null || num <= 0)
        out.push({ line, reason: r("pattern/not-a-number", token ? `"${token}" אינו מספר${gematria ? "" : " בספרות"}.` : "בתבנית אין קבוצה בסוגריים, ולכן אין מספר לקרוא. עטפו את המספר בסוגריים.") });
      else {
        const elements = parseHeading(m[0]);
        const found = elements.length ? elements[elements.length - 1]! : null;
        const element: PathElement = found && found.n === num ? found : { kind: "?", n: num, label: toGematria(num) };
        const end = m.index + m[0].length;
        out.push({ pos, line, num, shown: m[0], token, rawStart: map.starts[m.index]!, rawEnd: map.ends[end - 1]!, vStart: m.index, vEnd: end, ref: { elements: [element] }, ambiguous: false });
      }
      if (!all) break;
    }
    return out;
  };
}

/** A template (a preset, or the user's own with placeholders): every group says what its part is. */
function templateFinder(regex: RegExp, groups: readonly GroupSpec[], all: boolean, chain: boolean, stats: { notNumbers: number; samples: string[] }): Finder {
  return (text, line, pos) => {
    const map = visibleMap(text);
    const vis = map.text;
    regex.lastIndex = 0;
    const out: Match[] = [];
    for (const m of vis.matchAll(regex)) {
      if (!m[0].length) continue;
      const read = readGroups(m, groups, vis);
      if (read.bad && !read.elements.length && read.name === undefined) {
        stats.notNumbers++;
        if (stats.samples.length < 3 && !stats.samples.includes(m[0].trim())) stats.samples.push(m[0].trim());
      }
      if (!read.elements.length && read.name === undefined && read.flat === undefined) continue;
      const start = m.index;
      const end = Math.max(read.end, start + 1);
      const deepest = read.elements[read.elements.length - 1];
      const num = read.flat ?? deepest?.n ?? 0;
      out.push({
        pos,
        line,
        num,
        shown: vis.slice(start, end),
        token: read.token,
        rawStart: map.starts[start]!,
        rawEnd: map.ends[end - 1]!,
        vStart: start,
        vEnd: end,
        ref: { elements: read.elements, ...(read.to !== undefined ? { to: read.to } : {}) },
        ...(read.name !== undefined ? { name: { text: read.name, label: read.nameLabel, at: read.nameAt } } : {}),
        ...(read.book !== undefined ? { book: read.book } : {}),
        before: vis.slice(Math.max(0, start - BEFORE_WINDOW), start),
        after: vis.slice(end, end + AFTER_WINDOW),
        ambiguous: read.ambiguous,
      });
    }
    const merged = chain ? chainMatches(out, vis, map) : out;
    return all ? merged : merged.slice(0, 1);
  };
}

interface ReadGroups {
  elements: PathElement[];
  to?: number;
  book?: string;
  name?: string;
  nameLabel: string;
  nameAt: number;
  flat?: number;
  token: string;
  /** visible offset just after the last group that was read */
  end: number;
  ambiguous: boolean;
  /** a numeral group held something that is not a number */
  bad: boolean;
}

/** The groups of one match, in template order. A level that is not a number ends the reading. */
function readGroups(m: RegExpMatchArray, groups: readonly GroupSpec[], vis: string): ReadGroups {
  const out: ReadGroups = { elements: [], nameAt: 0, nameLabel: "", token: "", end: m.index!, ambiguous: false, bad: false };
  const indices = (m as RegExpMatchArray & { indices?: { groups?: Record<string, [number, number] | undefined> } }).indices?.groups ?? {};
  let prevEnd = m.index!;
  for (const g of groups) {
    const v = m.groups?.[g.name];
    const at = indices[g.name];
    if (v === undefined || !at) continue;
    const spec = g.spec;
    if (spec.role === "level" || spec.role === "any" || spec.role === "daf" || spec.role === "n") {
      // "פ"ק" is פרק קמא, the first chapter, not chapter 100
      const num = spec.role === "level" && spec.kind === "perek" && v === "ק" ? { n: 1, marked: true, ambiguous: false } : parseRefNumeral(v);
      if (!num) {
        out.bad = true;
        // "במ"ב פרק בתרא": the outer level is missing, so the inner one alone would be misplaced
        const kind = spec.role === "level" ? spec.kind : spec.role === "daf" ? "daf" : "?";
        if (out.elements.some((e) => rankOf(e.kind) >= rankOf(kind))) out.elements = [];
        break;
      }
      if (spec.role === "n") {
        out.flat = num.n;
        out.token = v;
        out.end = at[1];
        prevEnd = at[1];
        continue;
      }
      const kind = spec.role === "daf" ? "daf" : spec.role === "level" ? spec.kind : inferKind(vis.slice(prevEnd, at[0]));
      // a bare "(לא)" is a word, not a number
      if (num.ambiguous && kind === "?") {
        out.bad = true;
        break;
      }
      out.ambiguous ||= num.ambiguous;
      out.elements.push(kind === "daf" ? dafElement(num.n, undefined) : { kind, n: num.n, label: kind === "?" ? toGematria(num.n) : `${kindWord(kind)} ${toGematria(num.n)}` });
      out.token = v;
      out.end = at[1];
    } else if (spec.role === "amud") {
      const side = parseAmud(v);
      const last = out.elements[out.elements.length - 1];
      if (side && last?.kind === "daf" && last.amud === undefined) {
        out.elements[out.elements.length - 1] = dafElement(last.n!, side);
        out.end = at[1];
      }
    } else if (spec.role === "to") {
      const t = parseRefNumeral(v);
      const last = out.elements[out.elements.length - 1];
      if (t && !t.ambiguous && last?.n !== undefined && last.kind !== "daf" && t.n > last.n && t.n - last.n <= MAX_RANGE) {
        out.to = t.n;
        out.end = at[1];
      }
    } else if (spec.role === "book") {
      out.book = v.trim();
    } else if (spec.role === "name") {
      // the name is matched against the target's headings with the words after it ("שער הבטחון פרק ג")
      out.name = vis.slice(at[0], at[0] + NAME_WINDOW).trim();
      out.nameLabel = v.trim();
      out.nameAt = out.elements.length;
      out.end = at[1];
    }
    prevEnd = at[1];
  }
  // "משנה ה' פ"ג": levels written deepest first are read in their usual order (פרק › משנה)
  if (out.elements.length > 1) out.elements = [...out.elements].sort((a, b) => rankOf(a.kind) - rankOf(b.kind));
  return out;
}

/** the usual order of levels, outer first; kinds at the same rank keep the template's order */
const RANK: Readonly<Record<string, number>> = {
  sefer: 0, chelek: 0, shaar: 1, maamar: 1, klal: 1, parsha: 1, shoresh: 1, tikun: 1, drush: 1,
  perek: 2, siman: 2, daf: 2, mizmor: 2, mitzva: 2, teshuva: 2,
  mishna: 3, halacha: 3, pasuk: 3, seif: 3, os: 3, note: 3, amud: 3, seifkatan: 4, "?": 5,
};
const rankOf = (kind: string): number => RANK[kind] ?? 3;

/** The kind word right before a {מספר}: "בסי' " → siman, "ס"ק " → seifkatan, "סעיף קטן " → seifkatan. */
function inferKind(before: string): string {
  const words = before.trim().replace(/[,:]$/, "").split(/\s+/).filter(Boolean);
  const tries: string[] = [];
  if (words.length >= 2) tries.push(`${words[words.length - 2]} ${words[words.length - 1]}`);
  if (words.length) tries.push(words[words.length - 1]!);
  for (const w of tries) {
    for (let cut = 0; cut <= 2; cut++) {
      if (cut && !/^[ובלמהדשכ]/.test(w.slice(cut - 1))) break;
      const k = kindOfWord(w.slice(cut));
      if (k) return k === "amud" ? "?" : k;
    }
  }
  return "?";
}

/** "סימן ה, סעיף ג": consecutive single references of different kinds are one path. */
function chainMatches(ms: readonly Match[], vis: string, map: ReturnType<typeof visibleMap>): Match[] {
  const out: Match[] = [];
  for (const m of ms) {
    const prev = out[out.length - 1];
    const gap = prev ? vis.slice(prev.vEnd, m.vStart) : "";
    const kinds = new Set(prev?.ref.elements.map((e) => e.kind));
    const first = m.ref.elements[0];
    if (prev && first && /^[\s,]{0,3}$/.test(gap) && prev.ref.to === undefined && !prev.name && !m.name && !kinds.has(first.kind) && first.kind !== "?" && !kinds.has("?")) {
      out[out.length - 1] = {
        ...prev,
        num: m.num,
        token: m.token,
        shown: vis.slice(prev.vStart, m.vEnd),
        rawEnd: map.ends[m.vEnd - 1]!,
        vEnd: m.vEnd,
        ref: { elements: [...prev.ref.elements, ...m.ref.elements], ...(m.ref.to !== undefined ? { to: m.ref.to } : {}) },
        ambiguous: prev.ambiguous || m.ambiguous,
      };
    } else out.push(m);
  }
  return out;
}

function tagFinder(tag: string, options: PatternOptions, all: boolean): Finder {
  const numbering = options.gematria === false ? ("digits" as const) : undefined;
  return (text, line, pos) => {
    const ms = detectMarkers(text, { tag }, numbering ? { numbering } : {}).filter((m) => m.numbering !== "stars" && m.num > 0);
    return (all ? ms : ms.slice(0, 1)).map((m) => ({
      pos, line, num: m.num, shown: m.visible, token: m.token, rawStart: m.rawStart, rawEnd: m.rawEnd, vStart: 0, vEnd: 0,
      ref: { elements: [{ kind: "?", n: m.num, label: toGematria(m.num) }] }, ambiguous: false,
    }));
  };
}

/** at most two short words before a reference that opens a line ("(", "<b>", "מ"א") */
const START_RE = /^[\s([*•]*(?:[^\s()]{1,6}\s){0,2}[\s([]*$/;

function startOnly(finder: Finder): Finder {
  return (text, line, pos) => {
    const all = finder(text, line, pos);
    const first = all.find((m) => "reason" in m || START_RE.test(m.before ?? (m.vStart === 0 ? "" : "x".repeat(99))));
    return first && !("reason" in first) ? [first] : [];
  };
}

/** Lines without a reference inherit the last suggestion above them, up to the next heading; never certain. */
function carryForward(source: EngineBook, suggestions: readonly Suggestion[], thresholds: ConfidenceThresholds): Suggestion[] {
  const byLine = new Map<number, Suggestion>();
  for (const s of suggestions) if (!byLine.has(s.source.line)) byLine.set(s.source.line, s);
  const out: Suggestion[] = [];
  let last: Suggestion | null = null;
  for (const l of source.lines) {
    if (l.heading !== null) { last = null; continue; }
    const own = byLine.get(l.index);
    if (own) { last = own; continue; }
    if (!last || (stripTags(l.text).match(/[א-ת]/g) ?? []).length < 2) continue;
    const score = Math.min(last.score, CARRY_CAP);
    out.push({
      ...last,
      id: `${last.id.split(">")[0]!.replace(/#\d+@\d+$/, "")}#${l.index}~>${last.id.split(">")[1]}`,
      source: { book: source.book, line: l.index },
      score,
      confidence: confidenceOf(score, null, thresholds),
      reasons: [r("pattern/carried", `בשורה אין הפניה; היא ממשיכה את שורה ${last.source.line + 1}.`), ...last.reasons.slice(1)],
      rules: [...last.rules, "pattern.carried"],
      alternatives: [],
      warnings: last.warnings,
    });
    const { anchor: _drop, ...rest } = out[out.length - 1]!;
    out[out.length - 1] = rest;
  }
  return out;
}

/** The matches in every non-heading source line, in order; null when aborted. */
function findMatches(source: EngineBook, finder: Finder, ctx: EngineContext, unmatched: { line: number; reasons: Reason[] }[]): Match[] | null {
  const out: Match[] = [];
  const lines = source.lines;
  for (let k = 0; k < lines.length; k++) {
    if (k % PROGRESS_EVERY === 0) {
      if (ctx.signal?.aborted) return null;
      ctx.progress?.(k, lines.length);
    }
    const l = lines[k]!;
    if (l.heading !== null || l.text.length > MAX_CUSTOM_REGEX_INPUT) continue;
    for (const m of finder(l.text, l.index, k)) {
      if ("reason" in m) unmatched.push({ line: m.line, reasons: [m.reason] });
      else out.push(m);
    }
  }
  ctx.progress?.(lines.length, lines.length);
  return out;
}

function placer(mode: PatternTarget, source: EngineBook, target: EngineBook, options: PatternOptions, notes: Reason[], found: readonly Match[]): (m: Match) => Placed | Unplaced {
  if (mode === "chapter-line") return chapterPlacer(target, notes, found);
  if (mode === "tree") return treePlacer(source, target, options, notes);
  // "line": the number is the 1-based line number of the target
  const byIndex = new Map(target.lines.map((l) => [l.index, l]));
  const count = target.lines.length;
  return (m) => {
    const line = byIndex.get(m.num - 1);
    if (!line) return { unplaced: r("pattern/out-of-range", `ביעד אין שורה ${m.num} (יש בו ${count.toLocaleString("he")} שורות).`) };
    if (line.heading !== null) return { unplaced: r("pattern/target-heading", `שורה ${m.num} ביעד היא כותרת. אוצריא מדלגת על קישור לשורת כותרת.`) };
    return { target: { book: target.book, line: line.index }, score: SCORE.exact, reasons: [r("pattern/line", `המספר הוא מספר השורה ביעד (שורה ${m.num}).`)], warnings: [], alternatives: [], rules: [] };
  };
}

/** The reference is a place in the target's heading tree (pattern/tree.ts). */
function treePlacer(source: EngineBook, target: EngineBook, options: PatternOptions, notes: Reason[]): (m: Match) => Placed | Unplaced {
  const tree = new TargetTree(target);
  if (!tree.hasNumberedHeadings && !tree.structure.markerLines) notes.push(r("pattern/no-numbered-headings", "ביעד אין כותרות ממוספרות ולא שורות ממוספרות, ולכן אין לאן לקשר לפי מקום מבני."));
  if (tree.structure.untagged) notes.push(r("pattern/untagged-headings", `ביעד זוהו ${tree.structure.untagged} שורות כותרת בלי תגית (כמו "סימן ה" בשורה לבדה), והן משמשות כמו כותרות.`));
  const useContext = options.context !== false;
  const guardBooks = options.otherBooks !== false;
  const sourceStructure = useContext ? analyzeBook(source, { numbering: "lenient", untaggedHeadings: true }) : null;
  const opts = { sectionRanges: options.sectionRanges === true, context: useContext };
  // a list of references after another book's name stays with it until the text returns to this book
  // ("ברש"י שבת טז ע"ב ד"ה… יז ע"א ד"ה…", "פי"ח דשבת … שם משנה א")
  let sticky: { line: number; book: string } | null = null;
  let previous: { line: number; path: readonly PathElement[] } | null = null;
  return (m) => {
    let other = guardBooks && m.before !== undefined ? otherBook(m.before, m.after ?? "", target.book.title, tree.structure.kinds) : undefined;
    if (other) sticky = { line: m.line, book: other };
    else if (guardBooks && sticky?.line === m.line && !BACK_HOME_RE.test((m.before ?? "").slice(-24))) other = sticky.book;
    else sticky = null;
    if (other) return { unplaced: r("pattern/other-book", `לפני ההפניה כתוב "${other}": זו הפניה לספר אחר, לא לספר היעד.`) };
    if (m.book !== undefined && !bookMatches(m.book, target.book.title)) return { unplaced: r("pattern/other-book", `ההפניה היא ל"${m.book}", לא לספר היעד "${target.book.title}".`) };
    let elements = m.ref.elements;
    if (m.name) {
      const named = tree.resolveName(m.name.text);
      if (!named) return { unplaced: r("pattern/no-heading", `ביעד אין כותרת בשם "${m.name.label}".`) };
      const kinds = new Set(elements.map((e) => e.kind));
      elements = [...elements.slice(0, m.name.at), ...named.filter((e) => !kinds.has(e.kind)), ...elements.slice(m.name.at)];
    }
    if (!elements.length) return { unplaced: r("pattern/no-heading", "בהפניה אין מקום לקרוא.") };
    // "בפ"ק משנה ד' … שם משנה ב'": "שם" (ibid) is the place of the reference before it in the line
    const ibid = previous?.line === m.line && IBID_RE.test((m.before ?? "").slice(-8));
    const context = ibid ? previous!.path : (sourceStructure?.lines[m.pos]?.path ?? []);
    const p = tree.place({ elements, ...(m.ref.to !== undefined ? { to: m.ref.to } : {}) }, ibid ? context : context, { ...opts, context: useContext || ibid });
    if (!("unplaced" in p)) previous = { line: m.line, path: tree.pathAt(p.target.line) ?? elements };
    if ("unplaced" in p || !m.ambiguous || p.score <= SCORE.ambiguous) return p;
    return { ...p, score: SCORE.ambiguous, warnings: [...p.warnings, r("pattern/ambiguous-number", `המספר "${m.token}" הוא גם מילה רגילה; כדאי לוודא שזו באמת הפניה.`)] };
  };
}

/**
 * v3's chapter-aware resolution: the target's text lines are grouped into chapters at headings; the
 * numbers of the source are read in order, and a number that does not grow starts the next chapter.
 */
function chapterPlacer(target: EngineBook, notes: Reason[], found: readonly Match[]): (m: Match) => Placed | Unplaced {
  const chapters: { title: string; lines: number[] }[] = [];
  let cur: { title: string; lines: number[] } | null = null;
  for (const l of target.lines) {
    if (l.heading !== null) chapters.push((cur = { title: stripTags(l.text).trim(), lines: [] }));
    else (cur ??= (chapters.push({ title: "", lines: [] }), chapters[0]!)).lines.push(l.index);
  }
  const textChapters = chapters.filter((c) => c.lines.length);
  // which chapter each match falls in, decided once, in order
  const chapterOf = new Map<Match, number>();
  let ch = 0;
  let last: number | null = null;
  let resets = 0;
  for (const m of found) {
    if (last !== null && m.num <= last) (ch++, resets++);
    last = m.num;
    chapterOf.set(m, ch);
  }
  const series = resets + 1;
  const agrees = series === textChapters.length;
  if (found.length)
    notes.push(
      agrees
        ? r("pattern/chapters-agree", `המספור במקור מתחיל מחדש ${resets} פעמים, ובדיוק כמספר הפרקים ביעד (${textChapters.length}).`)
        : r("pattern/chapters-differ", `המספור במקור מתחיל מחדש ${resets} פעמים (${series} סדרות), אבל ביעד ${textChapters.length} פרקים. השיוך לפרקים לפי המספור בלבד, ולכן ההצעות מסומנות לבדיקה.`),
    );
  return (m) => {
    const c = chapterOf.get(m)!;
    const chapter = textChapters[c];
    if (!chapter) return { unplaced: r("pattern/no-chapter", `לפי המספור זה פרק ${c + 1}, וביעד יש רק ${textChapters.length} פרקים.`) };
    const line = chapter.lines[m.num - 1];
    if (line === undefined) return { unplaced: r("pattern/not-in-chapter", `בפרק ${c + 1} של היעד${chapter.title ? ` ("${chapter.title}")` : ""} יש ${chapter.lines.length} שורות, ואין שורה ${m.num}.`) };
    const score = agrees ? SCORE.exact : SCORE.reset;
    return {
      target: { book: target.book, line },
      score,
      reasons: [r("pattern/chapter-line", `שורה ${m.num} בפרק ${c + 1} של היעד${chapter.title ? ` ("${chapter.title}")` : ""}.`)],
      warnings: agrees ? [] : [r("pattern/chapter-guess", "הפרק נקבע רק לפי חזרת המספור לאחור, ומספר הסדרות שונה ממספר הפרקים ביעד.")],
      alternatives: [],
      rules: [agrees ? "pattern.chapters-agree" : "pattern.chapters-differ"],
    };
  };
}

/** heRef_2 of a target line: the database's own reference when it has one, else title + heading path (levels 2+). */
function heRefIndex(book: EngineBook): (line: number) => string {
  const title = book.book.title;
  const titleKey = normalize(title);
  const refs = new Map<number, string>();
  const stack: string[] = [];
  for (const l of book.lines) {
    if (l.heading !== null) {
      stack.length = l.heading - 1;
      stack[l.heading - 1] = stripTags(l.text).trim();
    }
    if (l.heRef) {
      refs.set(l.index, l.heRef);
      continue;
    }
    const parts = stack.slice(1).filter((x) => x && !titleKey.includes(normalize(x)));
    refs.set(l.index, parts.length ? `${title}, ${parts.join(", ")}` : title);
  }
  return (line) => refs.get(line) ?? title;
}

/** Anchors only where Otzaria keeps them: two library books, in a direction the import does not flip. */
function anchorDecision(source: BookRef, target: BookRef, declaredType: string, mode: "auto" | "off"): { allowed: boolean; reason: Reason } {
  if (mode === "off") return { allowed: false, reason: r("pattern/anchors-off", "עוגנים כובו בהגדרות: הקישורים יוצגו בפאנל הקישורים בלבד, בלי סימון המילים.") };
  if (source.origin !== "otzaria" || target.origin !== "otzaria")
    return { allowed: false, reason: r("pattern/anchors-origin", "אחד הספרים אינו ספר של ספריית אוצריא, ולכן הקישורים נכתבים בלי עוגן על המילים שנמצאו.") };
  if (!parseConnectionType(declaredType).known) return { allowed: false, reason: r("pattern/anchors-type", "סוג הקישור אינו מוכר לאוצריא, ולכן הקישורים נכתבים בלי עוגן.") };
  const f = storedForm({ source: { book: source, line: 0 }, target: { book: target, line: 0 }, declaredType });
  if (f.flipped || f.downgraded || f.skipped)
    return { allowed: false, reason: r("pattern/anchors-flip", "בסוג הקישור הזה אוצריא הייתה הופכת את כיוון הקישור, והעוגן היה נזרק. הקישורים נכתבים בלי עוגן.") };
  return { allowed: true, reason: r("pattern/anchors", "כל קישור מסמן את המילים שהתבנית מצאה (עוגן), כך שבאוצריא הן יוצגו כקישור בתוך הטקסט.") };
}
