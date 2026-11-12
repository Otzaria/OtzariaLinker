import { parseConnectionType } from "../../../core/links/connection-type";
import type { BookRef, LinkSide, RawAnchor } from "../../../core/links/model";
import { storedForm } from "../../../core/links/stored-form";
import { anchorLabelFromHeRef, withAnchorLabel } from "../../../core/text/anchor-label";
import { parseNumberToken, toGematria } from "../../../core/text/gematria";
import { stripTags } from "../../../core/text/html";
import { normalize } from "../../../core/text/hebrew";
import { checkCustomPattern, MAX_CUSTOM_REGEX_INPUT } from "../../../core/text/safe-regex";
import { visibleMap } from "../../../core/text/visible-map";
import { detectMarkers } from "../footnotes/markers";
import { parseHeading, type PathElement } from "../headings/numbering";
import { confidenceOf, DEFAULT_THRESHOLDS, type Candidate, type ConfidenceThresholds, type EngineBook, type EngineContext, type EngineResult, type Reason, type Suggestion } from "../types";

/*
 * The pattern engine — v3's "לפי תבנית" (FEATURE_INVENTORY F-100/F-101, buildRegex/resolveTargets),
 * rebuilt as a suggestion engine. The user writes a regular expression; in every source line its
 * capture group (named `n`, else group 1) is read as a NUMBER, and the number says where to link:
 *
 *   target "line"          the number is a line number of the target book (1-based)        — v3 default
 *   target "chapter-line"  the number is the N-th text line of the current chapter of the target;
 *                          the target is cut into chapters at its headings, and a number that is not
 *                          larger than the previous one moves to the next chapter               — v3 option
 *   target "heading"       the number is the number of a HEADING of the target ("סימן יב"); the link
 *                          goes to the first text line under it (with the section as a range on request)
 *
 * Instead of a pattern the number may be the content of a TAG (v3's "לפי תגיות", F-099: by default
 * `<sup>`): the tag is read with the footnotes engine's marker reader (broken tags repaired, "3,4"
 * split), and the anchor is the whole element.
 *
 * Changed from v3, on purpose:
 *   • The pattern runs on the VISIBLE text (tags hidden, entities one unit) and the anchor is mapped
 *     back to raw offsets with the generator's rules — v3 matched stripped text and wrote its offsets
 *     as raw ones, so anchors drifted after every tag (TECHNICAL_DEBT TD-H4).
 *   • The pattern goes through the same guard as every user pattern (core/text/safe-regex.ts).
 *   • Heading lines are never an end of a suggestion: Otzaria skips such links (export/heading-line).
 *   • Every suggestion says why, and problems (number out of range, chapter missing, two headings with
 *     the same number) are reported per line instead of a flat list.
 */

/**
 * v3's default, `(?:דף|עמוד|סימן)\s+([א-ת]+|\d+)`, with its quantifiers bounded so the
 * user-pattern guard accepts it (it allows two unbounded ones), and gershayim allowed:
 * "דף 5", "סימן יב", "סימן י״ב", "עמוד ג".
 */
export const DEFAULT_PATTERN = "(?:דף|עמוד|סימן)\\s{1,3}([א-ת׳״'\"]{1,6}|\\d{1,4})";

export type PatternTarget = "line" | "chapter-line" | "heading";

export interface PatternOptions {
  /** the regular expression (see checkCustomPattern for what is refused). Default DEFAULT_PATTERN. */
  readonly regex?: string;
  /** read the number from the content of this tag instead of a pattern (v3 "לפי תגיות"), e.g. "sup" */
  readonly tag?: string;
  /** i, m, s, u only */
  readonly flags?: string;
  /** read Hebrew numerals ("יב") as numbers. Default true. */
  readonly gematria?: boolean;
  /** "first" (v3, default): the first match of a line only. "all": every match. */
  readonly matches?: "first" | "all";
  /** where the number points. Default "line". */
  readonly target?: PatternTarget;
  /** "heading" target: link to the whole section under the heading as a range. Default false. */
  readonly sectionRanges?: boolean;
  /** "Conection Type" of the suggestions. Default "reference" (v3's default for this method). */
  readonly declaredType?: string;
  /** "auto" (default): an anchor on the matched words when Otzaria keeps it; "off": none */
  readonly anchors?: "auto" | "off";
  readonly thresholds?: ConfidenceThresholds;
}

const ENGINE = "pattern";
const PROGRESS_EVERY = 500;
/** a number with a decided chapter only by a numbering reset (no heading confirms it) */
const SCORE = { exact: 1, reset: 0.9, headingKindless: 0.9, duplicateHeading: 0.9 } as const;

const r = (code: string, text: string): Reason => ({ code, text });

interface Match {
  readonly line: number;
  readonly num: number;
  /** the whole match, as the reader sees it */
  readonly shown: string;
  /** the number as written */
  readonly token: string;
  readonly rawStart: number;
  readonly rawEnd: number;
  /** what the match itself says about the target ("סימן יב" → siman 12), for the heading target */
  readonly element: PathElement | null;
}

type Placed = { readonly target: LinkSide; readonly score: number; readonly reasons: Reason[]; readonly warnings: Reason[]; readonly alternatives: Candidate[]; readonly rules: string[] };
type Unplaced = { readonly unplaced: Reason };

export function runPatternEngine(source: EngineBook, target: EngineBook, options: PatternOptions = {}, ctx: EngineContext = {}): EngineResult {
  const tag = options.tag?.replace(/[^a-zA-Z0-9:_-]/g, "") ?? "";
  const pattern = options.regex?.trim() || DEFAULT_PATTERN;
  const check = tag ? null : checkCustomPattern(pattern, options.flags ?? "");
  if (check && !check.ok) return { suggestions: [], notes: [r("pattern/invalid", `התבנית לא הורצה: ${check.reason}`)], unmatched: [] };
  const finder: Finder = check ? regexFinder(check.regex, options) : tagFinder(tag, options);
  const mode: PatternTarget = options.target ?? "line";
  const declaredType = options.declaredType?.trim() || "reference";
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const notes: Reason[] = [];
  const unmatched: { line: number; reasons: Reason[] }[] = [];

  const found = findMatches(source, finder, ctx, unmatched);
  if (found === null) return { suggestions: [], notes: [r("pattern/aborted", "הריצה בוטלה לפני שהסתיימה. לא נוצרו הצעות.")], unmatched: [] };
  if (!found.length) notes.push(r("pattern/no-matches", tag ? `בספר המקור אין אף תגית <${tag}> עם מספר.` : "התבנית לא נמצאה באף שורה של ספר המקור."));

  const place = placer(mode, target, options, notes, found);
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
      reasons: [r("pattern/match", `בשורה נמצא "${m.shown.trim()}", והמספר ${m.token} נקרא כ־${m.num}.`), ...p.reasons],
      rules: [`pattern.${mode}`, ...p.rules],
      alternatives: p.alternatives,
      warnings: p.warnings,
    });
  }
  const shared = [...perTarget.values()].filter((n) => n > 1).length;
  if (shared) notes.push(r("pattern/shared-targets", `${shared} שורות ביעד מקבלות יותר מהפניה אחת. זה תקין בהפניות, אבל בהערות שוליים זה סימן לטעות בתבנית או בחלוקה לפרקים.`));
  return { suggestions, notes, unmatched };
}

/** One line → its numbered matches (or the reason one is not a number). */
type Finder = (text: string, line: number) => (Match | { readonly line: number; readonly reason: Reason })[];

function regexFinder(regex: RegExp, options: PatternOptions): Finder {
  const gematria = options.gematria !== false;
  const all = options.matches === "all";
  return (text, line) => {
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
        const element = elements.length ? elements[elements.length - 1]! : null;
        out.push({ line, num, shown: m[0], token, rawStart: map.starts[m.index]!, rawEnd: map.ends[m.index + m[0].length - 1]!, element: element && element.n === num ? element : null });
      }
      if (!all) break;
    }
    return out;
  };
}

function tagFinder(tag: string, options: PatternOptions): Finder {
  const all = options.matches === "all";
  const numbering = options.gematria === false ? ("digits" as const) : undefined;
  return (text, line) => {
    const ms = detectMarkers(text, { tag }, numbering ? { numbering } : {}).filter((m) => m.numbering !== "stars" && m.num > 0);
    return (all ? ms : ms.slice(0, 1)).map((m) => ({ line, num: m.num, shown: m.visible, token: m.token, rawStart: m.rawStart, rawEnd: m.rawEnd, element: null }));
  };
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
    for (const m of finder(l.text, l.index)) {
      if ("reason" in m) unmatched.push({ line: m.line, reasons: [m.reason] });
      else out.push(m);
    }
  }
  ctx.progress?.(lines.length, lines.length);
  return out;
}

function placer(mode: PatternTarget, target: EngineBook, options: PatternOptions, notes: Reason[], found: readonly Match[]): (m: Match) => Placed | Unplaced {
  if (mode === "chapter-line") return chapterPlacer(target, notes, found);
  if (mode === "heading") return headingPlacer(target, options.sectionRanges === true, notes);
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

/** The number names a heading of the target: link to its first text line (or its whole section). */
function headingPlacer(target: EngineBook, ranges: boolean, notes: Reason[]): (m: Match) => Placed | Unplaced {
  interface Head { line: number; level: number; el: PathElement; first: number | null; last: number | null; title: string }
  const heads: Head[] = [];
  const lines = target.lines;
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]!;
    if (l.heading === null) continue;
    const els = parseHeading(l.text).filter((e) => e.n !== undefined);
    if (!els.length) continue;
    // the section: the lines after the heading until the next heading of the same or a higher level
    let first: number | null = null;
    let last: number | null = null;
    for (let j = k + 1; j < lines.length; j++) {
      const x = lines[j]!;
      if (x.heading !== null && x.heading <= l.heading) break;
      if (x.heading === null) (first ??= x.index), (last = x.index);
    }
    heads.push({ line: l.index, level: l.heading, el: els[els.length - 1]!, first, last, title: stripTags(l.text).trim() });
  }
  if (!heads.length) notes.push(r("pattern/no-numbered-headings", "ביעד אין כותרות ממוספרות, ולכן אין לאן לקשר לפי מספר כותרת."));
  const byNum = new Map<number, Head[]>();
  for (const h of heads) {
    const list = byNum.get(h.el.n!) ?? [];
    list.push(h);
    byNum.set(h.el.n!, list);
  }
  const sideOf = (h: Head): LinkSide => ({ book: target.book, line: h.first!, ...(ranges && h.last! > h.first! ? { end: h.last! } : {}) });
  return (m) => {
    let hs = (byNum.get(m.num) ?? []).filter((h) => h.first !== null);
    const kindKnown = m.element !== null && m.element.kind !== "?";
    if (kindKnown) {
      const same = hs.filter((h) => h.el.kind === m.element!.kind);
      if (same.length) hs = same;
      else if (hs.length) return { unplaced: r("pattern/heading-kind", `ביעד יש כותרת עם המספר ${m.num}, אבל לא מהסוג "${m.element!.label}".`) };
    }
    if (!hs.length) return { unplaced: r("pattern/no-heading", `ביעד אין כותרת עם המספר ${m.num} (${toGematria(m.num)}).`) };
    const [best, ...rest] = hs as [Head, ...Head[]];
    const score = rest.length ? SCORE.duplicateHeading : kindKnown ? SCORE.exact : SCORE.headingKindless;
    const altScore = SCORE.duplicateHeading;
    return {
      target: sideOf(best),
      score,
      reasons: [r("pattern/heading", `הכותרת "${best.title}" ביעד נושאת את המספר ${m.num}${kindKnown ? " ואותו סוג" : ""}.`)],
      warnings: kindKnown ? [] : [r("pattern/heading-kindless", "ההפניה לא אומרת אם זה סימן, פרק או סעיף; הכותרת נבחרה לפי המספר בלבד.")],
      alternatives: rest.slice(0, 3).map((h) => ({ target: sideOf(h), score: altScore, reasons: [r("pattern/heading-other", `גם הכותרת "${h.title}" (שורה ${h.line + 1}) נושאת את המספר ${m.num}.`)] })),
      rules: [kindKnown ? "pattern.heading-kind" : "pattern.heading-number"],
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
