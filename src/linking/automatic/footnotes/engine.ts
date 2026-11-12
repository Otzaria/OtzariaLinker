import { APP_DEPENDENT_TYPES, parseConnectionType } from "../../../core/links/connection-type";
import type { RawAnchor } from "../../../core/links/model";
import { isMergeableCompanionTitle } from "../../../core/links/titles";
import { sefariaOwnedOf, type SefariaOwnedOption } from "../../../core/links/sefaria-owned";
import { anchorLabelFromHeRef, withAnchorLabel } from "../../../core/text/anchor-label";
import { toGematria } from "../../../core/text/gematria";
import { stripTags } from "../../../core/text/html";
import { normalize } from "../../../core/text/hebrew";
import { confidenceOf, type Candidate, type EngineBook, type EngineContext, type EngineResult, type Reason, type Suggestion } from "../types";
import { alignChapters } from "./align";
import { headingCounter, headingSections, isPlainKey, pairSections, resetChapters, type Chapter, type Occ } from "./chapters";
import {
  MAX_CUSTOM_REGEX_INPUT, appRecognisesMarker, compileStyle, detectMarkers, labelCommentators, leadingMarker,
  type CompiledStyle, type Marker, type MarkerStyle, type Numbering,
} from "./markers";

/*
 * The footnotes engine (plan stage 8.3) — a port of Otzaria/Link-Notes @ b1e0670 (index.html
 * buildLinks / shouldAdvanceBookChapter / diagnoseMissingIn* / collectMissingInBook /
 * reportGeneratorCompatibility), turned into a pure suggestion engine.
 *
 * Kept: exact key match (number + stars), chapter split where the notes numbering restarts, the
 * greedy advance rules and rescue pass (option chapterAlignment: "greedy"), the three diagnoses,
 * the "הערות על X" and popup checks. Changed, each measured on real data (tests/integration/
 * linking/footnotes): chapters chosen by a global alignment (align.ts); chapters anchored to
 * headings when both books have them (REUSE_MATRIX §2.2); a notes chapter may restart at 2;
 * stars-only markers paired by order; inline-note markers of another notes book skipped; markers
 * on heading lines reported instead of linked; notes without markers counted per line; unlinked
 * headings that a merge would lose reported. Export validation itself stays in core/links/validate.
 */

/**
 * Options of runFootnotesEngine. Every field is optional; the defaults suit the common case of a
 * book with `<sup>` (or parenthesised) markers and a notes book whose lines open with the marker.
 */
export interface FootnotesOptions extends SefariaOwnedOption {
  /**
   * How markers are written in the MAIN book: "sup" | "sub" | "parentheses" | { tag } | { regex }.
   * "auto" (default) tries sup, sub and parentheses and keeps the one whose numbers best match the
   * notes book.
   */
  readonly mainMarkers?: MarkerStyle | "auto";
  /**
   * How a NOTE line opens. "auto" (default) recognises (12) [12] 12. 12) יב) <sup>יב</sup> <b>12</b>;
   * a style limits it to that style. "position": the note lines carry no number at all, and the n-th
   * note line of a section is note n of the same section in the book. "auto" falls back to it when
   * almost no note line opens with a marker and the notes book has section headings (POSITIONAL_MAX).
   */
  readonly notesMarkers?: MarkerStyle | "auto" | "position";
  /** "start" (default): a notes line counts only if it OPENS with its marker. "anywhere": every marker in it. */
  readonly notesMarkerPosition?: "start" | "anywhere";
  /**
   * "auto" (default): taken from the notes book — when ≥90% of its markers are digits (letters),
   * only digits (letters) are read in the main book. "any" reads both.
   */
  readonly numbering?: Numbering | "auto" | "any";
  /**
   * Where a new chapter (a new numbering series) starts:
   *   "reset"    — Link-Notes: the notes numbering restarts at 1; the main book follows it with the
   *                evidence rules of shouldAdvanceBookChapter plus a rescue pass.
   *   "headings" — every chapter has a heading: both books are cut at heading lines and the
   *                pieces are paired by heading text (resets inside a piece are still followed).
   *   "none"     — one numbering series for the whole book.
   *   "auto"     — "headings" when ≥80% of the notes sections that hold markers pair by heading
   *                text with a main section, else "reset". Default.
   */
  readonly chapterSplit?: "auto" | "reset" | "headings" | "none";
  /**
   * How the book's markers are assigned to the notes chapters of a numbering series:
   *   "global" (default) — all markers together, by dynamic programming (align.ts); handles short
   *                        chapters and back-references, and measures how sure each choice is.
   *   "greedy"           — Link-Notes' original marker-by-marker rules (shouldAdvanceBookChapter
   *                        + rescue pass), kept for comparison.
   */
  readonly chapterAlignment?: "global" | "greedy";
  /** with "headings": only headings of this level or higher (1…level) start a chapter. Default: every heading. */
  readonly headingLevel?: number;
  /** "Conection Type" of the suggestions. Default "footnotes". */
  readonly declaredType?: string;
  /**
   * Also read `<sup class="footnote-marker">` — the generator's markers of footnotes that are already
   * inline in the line (schema-7 line_note). Default false: they belong to another notes series.
   */
  readonly includeInlineNoteMarkers?: boolean;
}

const SCORE = { given: 1, confirmed: 1, reset: 0.9, rescued: 0.85, rescue: 0.75, sequence: 0.9, repeat: 0.9, broken: 0.9, closeCall: 0.75, otherChapter: 0.3 } as const;
const CLOSE_CALL_MARGIN = 0.3;
/** how the chapter of a match is known; "sequence" = stars-only markers paired by order */
type Alignment = "given" | "confirmed" | "reset" | "rescued" | "rescue" | "sequence";
const PROGRESS_EVERY = 256;
/*
 * Notes numbered by position. Sefaria's notes books (R' Hartman's notes on the Maharal: "הערות ומקורות
 * על תפארת ישראל", 6,091 links) print no number in the note line: the book holds
 * <i data-commentator data-label="12"></i>, and note 12 of a chapter is simply the 12th line under the
 * chapter's heading in the notes book. Measured on the real database: 6,085 of the 6,091 links follow
 * exactly that rule. "auto" uses it only when at most this share of the note lines opens with a
 * marker (the notes are unnumbered, not partly numbered), and only with sections paired by heading.
 */
const POSITIONAL_MAX = 0.1;
/** a section whose note count differs from its highest marker: an unnumbered note may have shifted the rest */
const POSITION_MISMATCH_SCORE = 0.75;
const LIST_MAX = 20;

const r = (code: string, text: string): Reason => ({ code, text });
const lineList = (xs: readonly number[]) =>
  xs.slice(0, LIST_MAX).map((x) => x + 1).join(", ") + (xs.length > LIST_MAX ? ` ועוד ${xs.length - LIST_MAX}` : "");

interface Hit {
  /** notes numbered by position: the section's note count and its highest marker in the book */
  readonly position?: { readonly notes: number; readonly mainMax: number };
  readonly occ: Occ;
  readonly chapter: Chapter;
  readonly lines: readonly number[];
  readonly alignment: Alignment;
  readonly repeat: boolean;
  readonly advanceReason: string | undefined;
  /** stars-only markers: position in the pairing */
  readonly seq?: { readonly index: number; readonly count: number };
  /** global alignment: how much worse the best other chapter is (align.ts) */
  readonly margin?: number;
}

interface Miss {
  readonly occ: Occ;
  readonly chapter: Chapter | undefined;
  readonly reason: Reason;
}

interface Transition {
  readonly atLine: number;
  readonly from: number;
  readonly to: number;
  readonly reason: string;
  readonly rescue: boolean;
}

class Aborted extends Error {}

export function runFootnotesEngine(main: EngineBook, notes: EngineBook, options: FootnotesOptions = {}, ctx: EngineContext = {}): EngineResult {
  const runNotes: Reason[] = [];
  try {
    return run(main, notes, options, ctx, runNotes);
  } catch (e) {
    if (!(e instanceof Aborted)) throw e;
    return { suggestions: [], notes: [...runNotes, r("footnotes/aborted", "הריצה בוטלה לפני שהסתיימה. לא נוצרו הצעות.")], unmatched: [] };
  }
}

function run(main: EngineBook, notes: EngineBook, options: FootnotesOptions, ctx: EngineContext, runNotes: Reason[]): EngineResult {
  const declaredType = options.declaredType?.trim() || "footnotes";
  const includeInline = options.includeInlineNoteMarkers === true;
  let work = 0;
  const total = main.lines.length * 2 + notes.lines.length * 2;
  let lastProgress = 0;
  const tick = (n = 1) => {
    work += n;
    if (work - lastProgress >= PROGRESS_EVERY || work >= total) {
      if (ctx.signal?.aborted) throw new Aborted();
      lastProgress = work;
      ctx.progress?.(Math.min(work, total), total);
    }
  };
  if (ctx.signal?.aborted) throw new Aborted();

  runNotes.push(...titleWarnings(notes, declaredType));

  /* ---- styles ---- */
  const notesOpt = options.notesMarkers ?? "auto";
  const notesStyle = notesOpt === "position" ? "auto" : compileOrNote(notesOpt, "הערות", runNotes);
  const mainStyleOpt = options.mainMarkers ?? "auto";
  const mainStyleFixed = mainStyleOpt === "auto" ? "auto" : compileOrNote(mainStyleOpt, "הספר", runNotes);
  if (notesStyle === null || mainStyleFixed === null) return { suggestions: [], notes: runNotes, unmatched: [] };

  /* ---- notes side ---- */
  const anywhere = options.notesMarkerPosition === "anywhere";
  const notesLines = notes.lines;
  let rawNoteOccs: Occ[] = [];
  let unmarkedNoteLines: number[] = [];
  const contentLines: number[] = [];
  for (const l of notesLines) {
    tick();
    if (l.heading !== null) continue;
    const text = withoutBom(l.text);
    if (!stripTags(text)) continue;
    contentLines.push(l.index);
    const found: Marker[] = anywhere
      ? notesStyle === "auto" ? withLead(text, includeInline) : detectMarkers(text, notesStyle, { includeInlineNoteMarkers: includeInline })
      : [leadingMarker(text, notesStyle, { includeInlineNoteMarkers: includeInline })].filter((m): m is Marker => m !== null);
    if (!found.length) unmarkedNoteLines.push(l.index);
    for (const m of found) rawNoteOccs.push({ line: l.index, marker: m });
  }
  const sectioned = notesLines.some((l) => l.heading !== null && l.heading > 1);
  const positional = notesOpt === "position" || (notesOpt === "auto" && !anywhere && sectioned && contentLines.length > 0 && rawNoteOccs.length <= contentLines.length * POSITIONAL_MAX);
  if (positional) {
    rawNoteOccs = positionalOccs(notesLines, contentLines, options.headingLevel);
    unmarkedNoteLines = [];
    runNotes.push(r("footnotes/positional", "שורות ספר ההערות אינן נפתחות במספר. כל שורה נחשבת להערה הבאה בפרק שלה: השורה ה־12 תחת כותרת היא הערה 12 של אותו פרק בספר. הפרקים מותאמים לפי הכותרות."));
  }
  const numbering = decideNumbering(options.numbering ?? "auto", rawNoteOccs);
  const noteOccs = numbering ? rawNoteOccs.filter((o) => o.marker.numbering === numbering || isStar(o)) : rawNoteOccs;
  if (!noteOccs.length) {
    runNotes.push(r("footnotes/no-notes", "לא נמצאו בספר ההערות שורות שנפתחות בסימן הערה (מספר או אות). בדקו את הגדרת הסימון של ההערות."));
    return { suggestions: [], notes: runNotes, unmatched: [] };
  }

  /* ---- main side ---- */
  const detectOpts = { ...(numbering ? { numbering } : {}), includeInlineNoteMarkers: includeInline };
  const noteNums = new Set(noteOccs.map((o) => o.marker.num));
  const mainStyle = mainStyleFixed === "auto" ? chooseMainStyle(main, detectOpts, noteNums, runNotes, ctx.signal) : mainStyleFixed;
  const mainOccs: Occ[] = [];
  const headingMarkers: Occ[] = [];
  let skippedLong = 0;
  let skippedInline = 0;
  for (const l of main.lines) {
    tick();
    const text = withoutBom(l.text);
    if (mainStyle.kind === "regex" && text.length > MAX_CUSTOM_REGEX_INPUT) {
      skippedLong++;
      continue;
    }
    const ms = detectMarkers(text, mainStyle, detectOpts);
    if (!includeInline && /footnote-marker/.test(text)) skippedInline += detectMarkers(text, mainStyle, { includeInlineNoteMarkers: true }).filter((m) => m.inlineNote).length;
    for (const m of ms) (l.heading !== null ? headingMarkers : mainOccs).push({ line: l.index, marker: m });
  }
  if (skippedLong) runNotes.push(r("footnotes/regex-long-lines", `${skippedLong} שורות ארוכות מ־${MAX_CUSTOM_REGEX_INPUT.toLocaleString("he")} תווים לא נסרקו בביטוי המותאם (הגנה מפני ביטוי איטי).`));
  if (skippedInline) runNotes.push(r("footnotes/inline-markers-skipped", `${skippedInline} סימנים מסוג <sup class="footnote-marker"> דולגו: אלה סימני הערות שכבר משולבות בשורה (מוזגו מספר "הערות על…") ואינם שייכים לספר ההערות הזה.`));
  if (!mainOccs.length) {
    runNotes.push(r("footnotes/no-markers", "לא נמצאו סימני הערה בספר. בדקו את סגנון הסימון (sup, sub, סוגריים או ביטוי מותאם)."));
    return { suggestions: [], notes: runNotes, unmatched: headingMarkers.map((o) => ({ line: o.line, reasons: [headingReason(o)] })) };
  }

  /* ---- chapters and the walk ---- */
  const mainHeadingBetween = headingCounter(main.lines);
  const notesHeadingBetween = headingCounter(notesLines);
  const plan = planChapters(main, notes, mainOccs, noteOccs, positional ? { ...options, chapterSplit: "headings" } : options, notesHeadingBetween, runNotes);
  if (positional && !plan.byHeadings) {
    runNotes.push(r("footnotes/positional-no-headings", "ההערות אינן ממוספרות, ואף כותרת בספר ההערות לא נמצאה גם בספר. בלי פרקים משותפים אי אפשר לדעת איזו שורה היא איזו הערה, ולכן לא הוצעו קישורים."));
    return { suggestions: [], notes: runNotes, unmatched: [] };
  }
  const hits: Hit[] = [];
  const misses: Miss[] = [];
  const transitions: Transition[] = [];
  const greedy = options.chapterAlignment === "greedy";
  for (const g of plan.groups) {
    const res = greedy
      ? walk(g.mainOccs, g.chapters, g.start, mainHeadingBetween, plan.chapters, tick)
      : walkGlobal(g.mainOccs, g.chapters, g.start, mainHeadingBetween, plan.chapters, tick, runNotes);
    // notes numbered by position: is the section's count of note lines its highest marker in the book?
    const position = positional ? { notes: g.chapters.reduce((n, c) => n + c.occs.length, 0), mainMax: g.mainOccs.reduce((n, o) => Math.max(n, o.marker.num), 0) } : undefined;
    hits.push(...(position ? res.hits.map((h) => ({ ...h, position })) : res.hits));
    misses.push(...res.misses);
    transitions.push(...res.transitions);
    const stars = pairStars(g.starMain, g.starNotes, g.label);
    hits.push(...stars.hits);
    misses.push(...stars.misses);
  }
  hits.sort((a, b) => a.occ.line - b.occ.line || a.occ.marker.rawStart - b.occ.marker.rawStart);
  for (const o of plan.orphanMain) misses.push({ occ: o, chapter: undefined, reason: r("footnotes/section-unpaired", `הסימן "${o.marker.visible.trim()}" נמצא תחת כותרת שאין לה כותרת מקבילה בספר ההערות.`) });

  /* ---- suggestions ---- */
  const merged = isMergeableCompanionTitle(notes.book.title);
  const typeShowsPopup = popupTypeOk(declaredType, notes.book.title);
  const heRefOf = notesHeRefs(notes);
  // the export refuses an anchor end on a Sefaria side (validate.ts sefaria/anchor-range): such a pair is linked line to line
  const owned = sefariaOwnedOf(options.sefariaOwned);
  const sefaria = owned(main.book) || owned(notes.book);
  if (sefaria) runNotes.push(r("footnotes/anchors-sefaria", "אחד הספרים הוא ספר של ספריא, והספרייה אינה מקבלת עוגן על הסימן בקישור כזה. הקישורים נכתבים משורה לשורה, בלי עוגן."));
  const noteLead = new Map<number, Marker>();
  for (const o of noteOccs) if (!noteLead.has(o.line)) noteLead.set(o.line, o.marker);
  const suggestions: Suggestion[] = [];
  let noPopup = 0;
  const linkedNoteLines = new Set<number>();
  for (const h of hits) {
    const s = buildSuggestion(h, main, notes, declaredType, heRefOf, noteLead, plan.chapters, { merged, typeShowsPopup, singleChapter: plan.chapters.length === 1, anchors: !sefaria });
    if (s.warnings.some((w) => w.code === "footnotes/no-popup")) noPopup++;
    h.lines.forEach((x) => linkedNoteLines.add(x));
    suggestions.push(s);
  }

  /* ---- run notes ---- */
  runNotes.push(r("footnotes/summary", `נמצאו ${mainOccs.length} סימנים בספר ו־${noteOccs.length} הערות; הוצעו ${suggestions.length} קישורים. ${describeStyle(mainStyle)}${numbering ? `, ${numbering === "digits" ? "מספרים" : "אותיות"} בלבד` : ""}.`));
  runNotes.push(r("footnotes/chapters", plan.describe));
  const resets = transitions.filter((t) => !t.rescue).length;
  const rescues = transitions.filter((t) => t.rescue).length;
  if (resets) runNotes.push(r("footnotes/resets", `המספור מתחיל מחדש ב־${resets} מקומות בספר (שורות ${lineList(transitions.filter((t) => !t.rescue).map((t) => t.atLine))}).`));
  if (rescues) runNotes.push(r("footnotes/rescues", `ב־${rescues} מקומות המעבר לפרק הבא בהערות הוסק בלי שהמספור בספר התחיל מחדש (למשל אחרי סימנים שלא נמצאו להם הערות). כדאי לבדוק אותם (שורות ${lineList(transitions.filter((t) => t.rescue).map((t) => t.atLine))}).`));
  const dups = plan.chapters.flatMap((c) => [...c.keyToLines.entries()].filter(([, ls]) => ls.length > 1).map(([, ls]) => ls[0]!));
  if (dups.length) runNotes.push(r("footnotes/duplicate-notes", `בספר ההערות יש סימנים שחוזרים פעמיים באותו פרק (שורות ${lineList(dups)}). קישורים אליהם מסומנים כעמומים.`));
  const lonely = noteOccs.filter((o) => !linkedNoteLines.has(o.line));
  if (lonely.length) runNotes.push(...notesWithoutMarker(lonely, mainOccs));
  if (unmarkedNoteLines.length)
    runNotes.push(r("footnotes/unmarked-note-lines", `${unmarkedNoteLines.length} שורות בספר ההערות אינן נפתחות בסימן (למשל המשך של הערה ארוכה), ולכן לא יקושרו (שורות ${lineList(unmarkedNoteLines)}).`));
  if (noPopup)
    runNotes.push(r("footnotes/no-popup", `ל־${noPopup} סימנים אוצריא לא תציג חלונית ריחוף: היא מזהה רק מספר בסוגריים "(12)" בטקסט, או אות בצורה המלאה <sup>(א)</sup>, ושורת ההערה חייבת להיפתח באותו סימן בדיוק. הקישורים עצמם יעבדו ויופיעו כעוגן על הסימן.`));
  if (merged) runNotes.push(...mergeNotes(notes, linkedNoteLines, unmarkedNoteLines));

  const unmatched = [
    ...misses.map((m) => ({ line: m.occ.line, reasons: [m.reason] })),
    ...headingMarkers.map((o) => ({ line: o.line, reasons: [headingReason(o)] })),
  ].sort((a, b) => a.line - b.line);
  return { suggestions, notes: runNotes, unmatched: mergeByLine(unmatched) };
}

/* ================================================================== the walk (Link-Notes buildLinks) */

function walk(
  occs: readonly Occ[], chapters: readonly Chapter[], start: Alignment, headingBetween: (a: number, b: number) => boolean,
  allChapters: readonly Chapter[], tick: () => void,
): { hits: Hit[]; misses: Miss[]; transitions: Transition[] } {
  const hits: Hit[] = [];
  const misses: Miss[] = [];
  const transitions: Transition[] = [];
  if (!chapters.length) {
    for (const occ of occs) misses.push({ occ, chapter: undefined, reason: diagnoseMissingInNotes(occ, undefined, allChapters) });
    return { hits, misses, transitions };
  }
  let active = 0;
  let alignment: Alignment = start;
  let state = { linkedCount: 0, maxSeen: 0, missesInRow: 0 };
  let seen = new Map<string, number>();

  const move = (reason: string, occ: Occ, prevLine: number | null, rescue: boolean) => {
    transitions.push({ atLine: occ.line, from: chapters[active]!.no, to: chapters[active + 1]!.no, reason, rescue });
    active++;
    const confirmed = prevLine !== null && headingBetween(prevLine, occ.line) && chapters[active]!.afterHeading;
    alignment = rescue ? "rescued" : confirmed ? "confirmed" : "reset";
    seen = new Map();
    state = { linkedCount: 0, maxSeen: 0, missesInRow: 0 };
  };

  for (let i = 0; i < occs.length; i++) {
    tick();
    const occ = occs[i]!;
    const prevLine = i > 0 ? occs[i - 1]!.line : null;
    const decision = shouldAdvance(occs, i, state, chapters[active]!, chapters[active + 1]);
    let advanceReason: string | undefined;
    if (decision) {
      move(decision, occ, prevLine, false);
      advanceReason = decision;
    }
    let lines = chapters[active]!.keyToLines.get(occ.marker.key);
    let rescuedHere = false;
    if (!lines && active < chapters.length - 1) {
      const next = chapters[active + 1]!;
      if (
        next.keyToLines.has(occ.marker.key) &&
        (state.missesInRow >= 2 ||
          (occ.marker.num <= 3 && state.maxSeen >= 5) ||
          (occ.marker.num === 1 && isPlainKey(occ.marker.key) && state.linkedCount >= 3))
      ) {
        move("מעבר הצלה לאחר פספוסים", occ, prevLine, true);
        lines = chapters[active]!.keyToLines.get(occ.marker.key);
        rescuedHere = true;
        advanceReason = "מעבר הצלה לאחר פספוסים";
      }
    }
    if (lines) {
      const prev = seen.get(occ.marker.key) ?? 0;
      seen.set(occ.marker.key, prev + 1);
      hits.push({ occ, chapter: chapters[active]!, lines, alignment: rescuedHere ? "rescue" : alignment, repeat: prev > 0, advanceReason });
      state.linkedCount++;
      state.missesInRow = 0;
      if (occ.marker.num > state.maxSeen) state.maxSeen = occ.marker.num;
    } else {
      state.missesInRow++;
      misses.push({ occ, chapter: chapters[active], reason: diagnoseMissingInNotes(occ, chapters[active], allChapters) });
    }
  }
  return { hits, misses, transitions };
}

/**
 * Stars-only markers ("*", "**") carry no number, so they are paired by ORDER inside a group (a
 * heading section, or the whole book): the i-th "*" of the book ↔ the i-th "*" note. Only when the
 * two counts agree — otherwise one missing star would shift every later pair.
 */
function pairStars(main: readonly Occ[], notes: readonly Occ[], label: string | undefined): { hits: Hit[]; misses: Miss[] } {
  const hits: Hit[] = [];
  const misses: Miss[] = [];
  if (!main.length) return { hits, misses };
  const chapter: Chapter = {
    no: -1, occs: notes, keyToLines: new Map(), firstLine: notes[0]?.line ?? 0, lastLine: notes.at(-1)?.line ?? 0, afterHeading: false,
    ...(label !== undefined ? { label } : {}),
  };
  for (const key of new Set(main.map((o) => o.marker.key))) {
    const ms = main.filter((o) => o.marker.key === key);
    const ns = notes.filter((o) => o.marker.key === key);
    if (ms.length === ns.length) {
      ms.forEach((occ, i) => hits.push({ occ, chapter, lines: [ns[i]!.line], alignment: "sequence", repeat: false, advanceReason: undefined, seq: { index: i, count: ms.length } }));
    } else {
      for (const occ of ms)
        misses.push({ occ, chapter: undefined, reason: r("footnotes/stars-count", `בספר יש ${ms.length} סימני "${key}"${label ? ` תחת "${label}"` : ""} ובהערות ${ns.length}. סימן בלי מספר מותאם רק לפי הסדר, ולכן רק כשהמספרים שווים.`) });
    }
  }
  return { hits, misses };
}

/**
 * The default walk: chapters chosen by the global alignment (align.ts), then the same exact-key
 * lookup and diagnostics as the Link-Notes walk. Falls back to the greedy walk for huge inputs.
 */
function walkGlobal(
  occs: readonly Occ[], chapters: readonly Chapter[], start: Alignment, headingBetween: (a: number, b: number) => boolean,
  allChapters: readonly Chapter[], tick: () => void, runNotes: Reason[],
): { hits: Hit[]; misses: Miss[]; transitions: Transition[] } {
  if (chapters.length <= 1) return walk(occs, chapters, start, headingBetween, allChapters, tick);
  const aligned = alignChapters(occs, chapters, headingBetween);
  if (!aligned) {
    runNotes.push(r("footnotes/align-too-big", "הספר גדול מדי ליישור פרקים כולל, ולכן הפרקים נקבעו בשיטה המקומית של Link-Notes (פחות מדויקת בפרקים קצרים)."));
    return walk(occs, chapters, start, headingBetween, allChapters, tick);
  }
  const hits: Hit[] = [];
  const misses: Miss[] = [];
  const transitions: Transition[] = [];
  let alignment: Alignment = start;
  let seen = new Map<string, number>();
  for (let i = 0; i < occs.length; i++) {
    tick();
    const occ = occs[i]!;
    const c = aligned.chapterOf[i]!;
    const prevC = i > 0 ? aligned.chapterOf[i - 1]! : 0;
    let advanceReason: string | undefined;
    if (c !== prevC || (i === 0 && c > 0)) {
      const chapter = chapters[c]!;
      const heading = i > 0 && chapter.afterHeading && headingBetween(occs[i - 1]!.line, occ.line);
      const restart = occ.marker.key === chapter.occs[0]!.marker.key;
      const skipped = c - prevC - 1;
      advanceReason = [
        restart ? "המספור מתחיל מחדש" : "המספר לא מתאים לפרק הקודם",
        heading ? "ובשני הספרים יש כאן כותרת" : "",
        skipped > 0 ? `(דילוג על ${skipped} פרקים בהערות שאין להם סימנים בספר)` : "",
      ].filter(Boolean).join(" ");
      transitions.push({ atLine: occ.line, from: chapters[prevC]!.no, to: chapter.no, reason: advanceReason, rescue: !restart });
      alignment = heading && restart ? "confirmed" : "reset";
      seen = new Map();
    }
    const chapter = chapters[c]!;
    const lines = chapter.keyToLines.get(occ.marker.key);
    if (lines) {
      const prev = seen.get(occ.marker.key) ?? 0;
      seen.set(occ.marker.key, prev + 1);
      hits.push({ occ, chapter, lines, alignment, repeat: prev > 0, advanceReason, margin: aligned.margin[i]! });
    } else misses.push({ occ, chapter, reason: diagnoseMissingInNotes(occ, chapter, allChapters) });
  }
  return { hits, misses, transitions };
}

/** Port of shouldAdvanceBookChapter — returns the (Hebrew) reason, or null to stay. */
function shouldAdvance(occs: readonly Occ[], idx: number, state: { linkedCount: number; maxSeen: number }, active: Chapter, next: Chapter | undefined): string | null {
  if (!next) return null;
  const curr = occs[idx]!.marker;
  const prev = idx > 0 ? occs[idx - 1]!.marker : null;
  const existsHere = active.keyToLines.has(curr.key);
  const existsNext = next.keyToLines.has(curr.key);
  if (curr.num === 1 && isPlainKey(curr.key) && state.linkedCount >= 2 && state.maxSeen >= 3 && prev && !(prev.num === 1 && isPlainKey(prev.key))) {
    const future = occs.slice(idx + 1, idx + 4).map((o) => o.marker);
    if (future.some((o) => (o.num === 2 || o.num === 3) && isPlainKey(o.key))) return "איפוס מספור קלאסי בספר";
  }
  if (prev && prev.num >= 5 && curr.num <= 3 && state.maxSeen >= 5 && !existsHere && existsNext) return "נפילת מספור חדה והמספר נמצא רק בפרק הבא";
  if (state.linkedCount >= 3 && !existsHere && existsNext) return "המזהה לא קיים בפרק הנוכחי אך קיים בפרק הבא";
  return null;
}

/* ================================================================== chapter planning */

interface Group {
  /** numbered markers only */
  readonly mainOccs: readonly Occ[];
  readonly chapters: readonly Chapter[];
  readonly start: Alignment;
  readonly starMain: readonly Occ[];
  readonly starNotes: readonly Occ[];
  readonly label?: string;
}

const isStar = (o: Occ) => o.marker.numbering === "stars";
const numbered = (xs: readonly Occ[]) => xs.filter((o) => !isStar(o));
const stars = (xs: readonly Occ[]) => xs.filter(isStar);

interface Plan {
  /** the chapters come from headings the two books share */
  readonly byHeadings?: boolean;
  readonly chapters: readonly Chapter[];
  readonly groups: readonly Group[];
  readonly orphanMain: readonly Occ[];
  readonly describe: string;
}

function planChapters(
  main: EngineBook, notes: EngineBook, mainOccs: readonly Occ[], noteOccs: readonly Occ[], options: FootnotesOptions,
  notesHeadingBetween: (a: number, b: number) => boolean, runNotes: Reason[],
): Plan {
  const mode = options.chapterSplit ?? "auto";
  const whole = (start: Alignment, split: boolean): Group & { chapters: Chapter[] } => ({
    mainOccs: numbered(mainOccs),
    chapters: resetChapters(numbered(noteOccs), 0, notesHeadingBetween, undefined, split),
    start,
    starMain: stars(mainOccs),
    starNotes: stars(noteOccs),
  });
  if (mode === "none") {
    const g = whole("given", false);
    return { chapters: g.chapters, groups: [g], orphanMain: [], describe: "כל ספר ההערות נקרא כסדרת מספור אחת (בלי פיצול לפרקים)." };
  }
  const level = options.headingLevel && options.headingLevel >= 1 && options.headingLevel <= 6 ? options.headingLevel : undefined;
  if (mode === "headings" || mode === "auto") {
    const ms = headingSections(main.lines, level);
    const ns = headingSections(notes.lines, level);
    const notesBySection = groupOccs(noteOccs, ns.sectionOf);
    const mainBySection = groupOccs(mainOccs, ms.sectionOf);
    const withOccs = ns.sections.filter((s) => notesBySection.has(s.id));
    // every main section takes part: a chapter whose markers are all missing must still claim its notes
    const pairs = pairSections(ms.sections, withOccs);
    const useHeadings = mode === "headings" ? pairs.size > 0 : withOccs.length >= 2 && pairs.size / withOccs.length >= 0.8;
    if (useHeadings) {
      const chapters: Chapter[] = [];
      const groups: Group[] = [];
      const pairedMain = new Set(pairs.values());
      for (const s of withOccs) {
        const mId = pairs.get(s.id);
        if (mId === undefined) continue;
        const inNotes = notesBySection.get(s.id)!;
        const inMain = mainBySection.get(mId) ?? [];
        const cs = resetChapters(numbered(inNotes), chapters.length, notesHeadingBetween, s.title);
        chapters.push(...cs);
        groups.push({ mainOccs: numbered(inMain), chapters: cs, start: "given", starMain: stars(inMain), starNotes: stars(inNotes), label: s.title });
      }
      // the rest (sections without a counterpart) falls back to the reset walk, in book order
      const leftNotes = withOccs.filter((s) => !pairs.has(s.id)).flatMap((s) => notesBySection.get(s.id)!);
      const leftMain = mainOccs.filter((o) => !pairedMain.has(ms.sectionOf[o.line]!));
      const orphanMain: Occ[] = [];
      if (leftNotes.length) {
        const cs = resetChapters(numbered(leftNotes), chapters.length, notesHeadingBetween);
        chapters.push(...cs);
        groups.push({ mainOccs: numbered(leftMain), chapters: cs, start: "reset", starMain: stars(leftMain), starNotes: stars(leftNotes) });
      } else orphanMain.push(...leftMain);
      const unpaired = withOccs.length - pairs.size;
      return {
        byHeadings: true,
        chapters, groups, orphanMain,
        describe: `הפרקים זוהו לפי כותרות: ${pairs.size} פרקים בהערות הותאמו לכותרת זהה בספר${unpaired ? `, ו־${unpaired} פרקים בלי כותרת מקבילה קושרו לפי איפוס המספור (בביטחון נמוך יותר)` : ""}.`,
      };
    }
    if (mode === "headings") runNotes.push(r("footnotes/headings-unpaired", "התבקש פיצול לפי כותרות, אבל אף כותרת בספר ההערות לא נמצאה גם בספר. נעשה פיצול לפי איפוס המספור."));
  }
  const g = whole("given", true);
  return {
    chapters: g.chapters,
    groups: [g],
    orphanMain: [],
    describe: g.chapters.length <= 1 ? "בספר ההערות יש סדרת מספור אחת." : `ספר ההערות פוצל ל־${g.chapters.length} פרקים לפי איפוס המספור (כל "1" או "א" פותח פרק).`,
  };
}

function groupOccs(occs: readonly Occ[], sectionOf: Int32Array): Map<number, Occ[]> {
  const m = new Map<number, Occ[]>();
  for (const o of occs) {
    const id = sectionOf[o.line] ?? 0;
    const list = m.get(id) ?? [];
    list.push(o);
    m.set(id, list);
  }
  return m;
}

/* ================================================================== suggestions */

function buildSuggestion(
  h: Hit, main: EngineBook, notes: EngineBook, declaredType: string, heRefOf: (line: number) => string, noteLead: ReadonlyMap<number, Marker>,
  chapters: readonly Chapter[], flags: { merged: boolean; typeShowsPopup: boolean; singleChapter: boolean; anchors: boolean },
): Suggestion {
  const m = h.occ.marker;
  const target = h.lines[0]!;
  const reasons: Reason[] = [];
  const warnings: Reason[] = [];
  const rules: string[] = [`marker:${m.style}`, h.seq ? "match:order" : "match:exact-key"];
  const shown = m.style === "label" ? m.token : m.visible.trim();
  if (h.position) {
    rules.push("notes:position");
    reasons.push(r("footnotes/position", `שורות ההערות אינן ממוספרות: השורה ${target + 1} היא ההערה ה־${m.num} תחת "${h.chapter.label ?? ""}" בספר ההערות, והסימן בשורה ${h.occ.line + 1} בספר הוא ${m.num}.`));
  } else if (h.seq)
    reasons.push(r("footnotes/sequence", `הסימן "${shown}" אינו מספר, ולכן הותאם לפי הסדר: הוא ה־${h.seq.index + 1} מתוך ${h.seq.count} בספר${h.chapter.label ? ` תחת "${h.chapter.label}"` : ""}, וההערה בשורה ${target + 1} היא ה־${h.seq.index + 1} מתוך ${h.seq.count} בהערות.`));
  else reasons.push(r("footnotes/exact", `הסימן "${shown}" בשורה ${h.occ.line + 1} זהה לסימן שבתחילת ההערה בשורה ${target + 1}.`));

  let score: number = SCORE[h.alignment];
  switch (h.alignment) {
    case "sequence":
      rules.push(h.chapter.label !== undefined ? "chapter:heading" : "chapter:book");
      break;
    case "given":
      if (h.chapter.label !== undefined) {
        rules.push("chapter:heading");
        reasons.push(r("footnotes/chapter-heading", `הפרק זוהה לפי כותרת זהה בשני הספרים ("${h.chapter.label}").`));
      } else if (flags.singleChapter) {
        rules.push("chapter:single");
        reasons.push(r("footnotes/chapter-single", "בספר ההערות יש סדרת מספור אחת, ולכן אין ספק לאיזו הערה הסימן שייך."));
      } else {
        rules.push("chapter:first");
        reasons.push(r("footnotes/chapter-first", "הסימן נמצא בפרק הראשון של ההערות, לפני כל איפוס מספור."));
      }
      break;
    case "confirmed":
      rules.push("chapter:reset+heading");
      reasons.push(r("footnotes/chapter-confirmed", "המספור מתחיל מחדש בשני הספרים, ובשניהם יש כותרת בדיוק במקום הזה."));
      break;
    case "reset":
      rules.push("chapter:reset");
      reasons.push(r("footnotes/chapter-reset", "הפרק הוסק מאיפוס המספור, בלי כותרת שמאשרת אותו."));
      break;
    case "rescued":
      rules.push("chapter:rescue");
      reasons.push(r("footnotes/chapter-rescued", "הפרק הוסק במעבר־הצלה, אחרי סימנים שלא נמצאו להם הערות."));
      break;
    case "rescue":
      rules.push("chapter:rescue", "pass:rescue");
      reasons.push(r("footnotes/rescue", "הסימן הזה לא נמצא בפרק הנוכחי של ההערות, ולכן הכלי עבר לפרק הבא (מעבר־הצלה)."));
      break;
  }
  if (h.advanceReason && h.alignment !== "rescue") reasons.push(r("footnotes/advance", `כאן מתחיל פרק חדש בהערות: ${h.advanceReason}.`));
  // Calibrated on 25 real books (line-note-bench): inferred chapters were right 98.6% of the time for
  // every margin ≥ 0.3 (100% from 2 up); below 0.3 the other chapter is nearly as cheap.
  if (h.margin !== undefined && h.margin < CLOSE_CALL_MARGIN) {
    score = Math.min(score, SCORE.closeCall);
    rules.push("chapter:close-call");
    reasons.push(r("footnotes/close-call", "שיוך הסימן לפרק הזה בהערות כמעט שקול לשיוך לפרק אחר. כדאי לבדוק."));
  }
  if (h.position && h.position.notes !== h.position.mainMax) {
    score = Math.min(score, POSITION_MISMATCH_SCORE);
    rules.push("notes:position-count");
    reasons.push(r("footnotes/position-count", `בפרק הזה יש ${h.position.notes} שורות הערה, והסימן הגבוה בספר הוא ${h.position.mainMax}. ייתכן שהערה נמשכת על פני שתי שורות וכל ההערות שאחריה זזו, ולכן לבדיקה.`));
  }
  if (h.repeat) {
    score = Math.min(score, SCORE.repeat);
    rules.push("repeat");
    reasons.push(r("footnotes/repeat", "ההערה הזאת כבר קושרה מסימן קודם באותו פרק — הפניה חוזרת, או פרק שלא זוהה."));
  }
  if (m.broken) {
    score = Math.min(score, SCORE.broken);
    rules.push(`broken:${m.broken}`);
    warnings.push(r("footnotes/broken-tag", m.broken === "unclosed" ? "תגית הסימון לא נסגרת בשורה. הסימן זוהה, אבל כדאי לתקן את הספר." : "בתגית הסוגרת של הסימון חסר \">\". אוצריא תסתיר את המשך השורה עד ה־\">\" הבא — כדאי לתקן את הספר."));
  }
  const alternatives: Candidate[] = h.lines.slice(1).map((line) => ({
    target: { book: notes.book, line },
    score,
    reasons: [r("footnotes/duplicate", `גם שורה ${line + 1} בספר ההערות נפתחת באותו סימן באותו פרק.`)],
  }));
  if (alternatives.length) reasons.push(r("footnotes/duplicate", `בפרק הזה בהערות יש ${h.lines.length} הערות עם אותו סימן.`));
  for (const c of chapters) {
    if (c.no === h.chapter.no || alternatives.length >= 4) continue;
    const ls = c.keyToLines.get(m.key);
    if (ls) alternatives.push({ target: { book: notes.book, line: ls[0]! }, score: SCORE.otherChapter, reasons: [r("footnotes/other-chapter", `אותו סימן בפרק ${c.no + 1} של ההערות.`)] });
  }
  const runnerUp = h.lines.length > 1 ? score : null;

  if (flags.merged) warnings.push(r("footnotes/companion-merged", `שם ספר ההערות "${notes.book.title}" מתחיל ב"הערות על", ואוצריא ממזגת ספר כזה לתוך ספר הבסיס. לקישור הזה יש עוגן על הסימן, וזה מבטל את המיזוג: ההערות יישארו ספר נפרד והקישור יישמר.`));
  const line = withoutBom(main.lines[h.occ.line]?.text ?? "");
  const lead = noteLead.get(target);
  if (!appRecognisesMarker(line, m)) warnings.push(r("footnotes/no-popup", "אוצריא לא תציג חלונית ריחוף לסימן בצורה הזו (היא מזהה רק \"(12)\" או <sup>(א)</sup>). הקישור יופיע כעוגן על הסימן."));
  else if (lead && lead.visible.trim() !== shown) warnings.push(r("footnotes/note-opening-differs", `שורת ההערה נפתחת ב"${lead.visible.trim()}" ולא ב"${shown}". חלונית הריחוף של אוצריא דורשת פתיחה זהה בדיוק.`));
  else if (!flags.typeShowsPopup) warnings.push(r("footnotes/no-popup-type", "חלונית הריחוף דורשת סוג קשר FOOTNOTES (או שם ספר הערות שמתחיל ב\"הערות\")."));

  const label = labelOf(m);
  const heRef2 = withAnchorLabel(heRefOf(target), label);
  // a data-label element shows nothing: there are no characters to anchor on, the link is the line's
  const anchor: RawAnchor | undefined = m.style === "label" || !flags.anchors ? undefined : { rawStart: m.rawStart, rawEnd: m.rawEnd, ...(label && anchorLabelFromHeRef(heRef2) === label ? { label } : {}) };
  return {
    id: `footnotes:${main.book.key}#${h.occ.line}@${m.rawStart}>${notes.book.key}#${target}`,
    engine: "footnotes",
    source: { book: main.book, line: h.occ.line },
    ...(anchor && { anchor }),
    target: { book: notes.book, line: target },
    declaredType,
    heRef2,
    score,
    confidence: confidenceOf(score, runnerUp),
    reasons,
    rules,
    alternatives,
    warnings,
  };
}

/** The anchor label: the letters as written, or the Hebrew numeral of a digit marker. */
function labelOf(m: Marker): string | null {
  if (m.numbering === "stars") return null;
  const label = m.numbering === "letters" ? m.token.replace(/['׳]$/, "") : toGematria(m.num);
  return anchorLabelFromHeRef(` אות ${label}`) === label ? label : null;
}

/** heRef_2 of a notes line: the book title and the heading path above it (levels 2+). */
function notesHeRefs(notes: EngineBook): (line: number) => string {
  const title = notes.book.title;
  const titleKey = normalize(title);
  const paths: string[] = new Array(notes.lines.length);
  const stack: string[] = [];
  for (let i = 0; i < notes.lines.length; i++) {
    const l = notes.lines[i]!;
    if (l.heading !== null) {
      stack.length = l.heading - 1;
      stack[l.heading - 1] = stripTags(l.text);
    }
    const parts = stack.slice(1).filter((x) => x && !titleKey.includes(normalize(x)));
    paths[i] = parts.length ? `${title}, ${parts.join(", ")}` : title;
  }
  return (line) => paths[line] ?? title;
}

/* ================================================================== diagnostics */

/** Port of diagnoseMissingInNotes. */
function diagnoseMissingInNotes(occ: Occ, active: Chapter | undefined, all: readonly Chapter[]): Reason {
  const shown = occ.marker.visible.trim();
  const found = all.filter((c) => c.keyToLines.has(occ.marker.key)).map((c) => c.no + 1);
  if (found.length)
    return r("footnotes/wrong-chapter", `לסימן "${shown}" לא נמצאה הערה בפרק ${active ? active.no + 1 : "?"} של ההערות, אבל יש הערה כזו בפרק ${found.join(", ")}. ייתכן שהפרקים לא יושרו נכון.`);
  const sameNum = all.flatMap((c) => c.occs).find((o) => o.marker.num === occ.marker.num && o.marker.key !== occ.marker.key);
  if (sameNum)
    return r("footnotes/decoration-mismatch", `המספר של "${shown}" קיים בהערות, אבל בעיטור שונה ("${sameNum.marker.visible.trim()}", שורה ${sameNum.line + 1}) — כוכביות שונות אינן אותו סימן.`);
  return r("footnotes/not-found", `לסימן "${shown}" אין הערה באף פרק של ספר ההערות. בדקו את הגדרת הסימון, או שההערה חסרה.`);
}

/** Port of collectMissingInBook / diagnoseMissingInBook, per notes LINE (not per key of the whole book). */
function notesWithoutMarker(lonely: readonly Occ[], mainOccs: readonly Occ[]): Reason[] {
  const mainNums = new Set(mainOccs.map((o) => o.marker.num));
  const deco = lonely.filter((o) => mainNums.has(o.marker.num) && !mainOccs.some((m) => m.marker.key === o.marker.key));
  const out = [r("footnotes/note-without-marker", `ל־${lonely.length} הערות לא נמצא סימן בספר (שורות ${lineList(lonely.map((o) => o.line))}).`)];
  if (deco.length) out.push(r("footnotes/note-decoration-mismatch", `מהן ${deco.length} שהמספר שלהן קיים בספר אבל בעיטור שונה (כוכביות).`));
  return out;
}

const headingReason = (o: Occ) =>
  r("footnotes/heading-line", `הסימן "${o.marker.visible.trim()}" נמצא בשורת כותרת. אוצריא מדלגת על קישור שאחד מקצותיו כותרת, ולכן הוא לא הוצע.`);

function mergeByLine(xs: { line: number; reasons: Reason[] }[]): { line: number; reasons: Reason[] }[] {
  const out: { line: number; reasons: Reason[] }[] = [];
  for (const x of xs) {
    const last = out.at(-1);
    if (last && last.line === x.line) last.reasons.push(...x.reasons);
    else out.push({ line: x.line, reasons: [...x.reasons] });
  }
  return out;
}

/* ================================================================== run-level checks */

function titleWarnings(notes: EngineBook, declaredType: string): Reason[] {
  const out: Reason[] = [];
  if (isMergeableCompanionTitle(notes.book.title))
    out.push(r("footnotes/companion-merged", `שם ספר ההערות "${notes.book.title}" מתחיל ב"הערות על", והמחולל של אוצריא ממזג ספר כזה לתוך ספר הבסיס — אבל רק כשאין עוגן על שורות ההערות. המנוע הזה כותב עוגן על כל סימן, ולכן הקישורים שלו מבטלים את המיזוג: ההערות יישארו ספר נפרד והקישורים יישמרו. אם קובץ הקישורים של הבסיס בספרייה כבר ממזג את ההערות (רשומות בלי עוגן), הקישורים החדשים יבטלו את המיזוג הזה.`));
  if (!popupTypeOk(declaredType, notes.book.title))
    out.push(r("footnotes/no-popup-type", `סוג הקשר "${declaredType}" ושם ספר ההערות לא יאפשרו חלונית ריחוף על הסימנים המודפסים: נדרש סוג תלוי־טקסט, וגם סוג FOOTNOTES או שם ספר שמתחיל ב"הערות".`));
  return out;
}

function popupTypeOk(declaredType: string, notesTitle: string): boolean {
  const t = parseConnectionType(declaredType).type;
  return APP_DEPENDENT_TYPES.has(t) && (t === "FOOTNOTES" || notesTitle.trim().startsWith("הערות"));
}

/** Link-Notes reportGeneratorCompatibility, plus its known gap: unlinked HEADINGS are lost in a merge. */
function mergeNotes(notes: EngineBook, linked: ReadonlySet<number>, unmarked: readonly number[]): Reason[] {
  const headings = notes.lines.filter((l) => l.heading !== null && stripTags(l.text) && !linked.has(l.index)).length;
  const out: Reason[] = [];
  if (unmarked.length)
    out.push(r("footnotes/merge-blocked", `גם ${unmarked.length} שורות הערה שאינן מקושרות מונעות את המיזוג: ספר ההערות יישאר ספר נפרד והקישורים יישמרו.`));
  if (headings)
    out.push(r("footnotes/merge-loses-headings", `אם המיזוג כן יתבצע, ${headings} שורות כותרת בספר ההערות יאבדו: הן אינן מוזרקות לשום מקום.`));
  return out;
}

/* ================================================================== helpers */

function compileOrNote(style: MarkerStyle | "auto", side: string, runNotes: Reason[]): CompiledStyle | "auto" | null {
  if (style === "auto") return "auto";
  const c = compileStyle(style);
  if (c.ok) return c.compiled;
  runNotes.push(r("footnotes/bad-style", `הגדרת הסימון של ${side} נדחתה: ${c.reason}`));
  return null;
}

function decideNumbering(opt: Numbering | "auto" | "any", occs: readonly Occ[]): Numbering | null {
  if (opt === "digits" || opt === "letters") return opt;
  const counted = occs.filter((o) => !isStar(o));
  if (opt === "any" || !counted.length) return null;
  const digits = counted.filter((o) => o.marker.numbering === "digits").length;
  if (digits >= counted.length * 0.9) return "digits";
  if (counted.length - digits >= counted.length * 0.9) return "letters";
  return null;
}

const MAIN_CANDIDATES: readonly MarkerStyle[] = ["sup", "sub", "parentheses"];

function chooseMainStyle(
  main: EngineBook, opts: { numbering?: Numbering; includeInlineNoteMarkers: boolean }, noteNums: ReadonlySet<number>, runNotes: Reason[], signal: AbortSignal | undefined,
): CompiledStyle {
  let best: { style: CompiledStyle; matched: number; found: number } | null = null;
  // Sefaria's data-label markers, one candidate per commentator: a book may carry the notes of several
  const commentators = new Set<string>();
  for (const l of main.lines) for (const who of labelCommentators(l.text)) commentators.add(who);
  const candidates: MarkerStyle[] = [...MAIN_CANDIDATES, ...[...commentators].map((label) => ({ label }))];
  for (const s of candidates) {
    const c = compileStyle(s);
    if (!c.ok) continue;
    let matched = 0;
    let found = 0;
    for (const l of main.lines) {
      if ((l.index & 255) === 0 && signal?.aborted) throw new Aborted();
      if (l.heading !== null) continue;
      for (const m of detectMarkers(withoutBom(l.text), c.compiled, opts)) {
        found++;
        if (noteNums.has(m.num)) matched++;
      }
    }
    if (!best || matched > best.matched || (matched === best.matched && found > best.found)) best = { style: c.compiled, matched, found };
  }
  runNotes.push(r("footnotes/style-auto", `סגנון הסימון בספר נבחר אוטומטית: ${describeStyle(best!.style)}.`));
  return best!.style;
}

function describeStyle(s: CompiledStyle): string {
  if (s.kind === "label") return s.commentator ? `סימני ההערות של "${s.commentator}" (data-label)` : "סימני הערות מסוג data-label";
  if (s.kind === "parentheses") return "מספרים בסוגריים, כמו (12)";
  if (s.kind === "regex") return `ביטוי מותאם /${s.regex.source}/`;
  return `תגית <${s.tag}>`;
}

/**
 * Note lines with no marker, numbered by their place in their heading section (1, 2, 3 … under each
 * heading; POSITIONAL_MAX). The synthetic marker spans nothing: the anchor is on the book's side.
 */
function positionalOccs(lines: EngineBook["lines"], content: readonly number[], level: number | undefined): Occ[] {
  const { sectionOf } = headingSections(lines, level && level >= 1 && level <= 6 ? level : undefined);
  const out: Occ[] = [];
  let section = -1;
  let k = 0;
  for (const line of content) {
    const s = sectionOf[line] ?? 0;
    if (s !== section) (section = s), (k = 0);
    k++;
    const n = String(k);
    out.push({ line, marker: { rawStart: 0, rawEnd: 0, visible: n, token: n, num: k, key: n, numbering: "digits", decorated: false, style: "position" } });
  }
  return out;
}

/** The generator strips a BOM from the first line before it counts offsets (LINK_FORMATS §1.6). */
const withoutBom = (s: string): string => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

function withLead(text: string, includeInline: boolean): Marker[] {
  const lead = leadingMarker(text, "auto", { includeInlineNoteMarkers: includeInline });
  const rest = [...detectMarkers(text, "sup", { includeInlineNoteMarkers: includeInline }), ...detectMarkers(text, "parentheses")];
  const all = lead ? [lead, ...rest.filter((m) => m.rawStart >= lead.rawEnd)] : rest;
  return all.sort((a, b) => a.rawStart - b.rawStart);
}
