import { runToEnd, type EngineSteps } from "../steps";
import type { LinkSide } from "../../../core/links/model";
import { firstRefIn, refBlockOf, sefariaOwnedOf, withoutRange, type SefariaOwnedOption } from "../../../core/links/sefaria-owned";
import { toGematria } from "../../../core/text/gematria";
import {
  capSpanned,
  confidenceOf,
  DEFAULT_THRESHOLDS,
  type Candidate,
  type Confidence,
  type ConfidenceThresholds,
  type EngineBook,
  type EngineContext,
  type EngineResult,
  type Reason,
  type Suggestion,
} from "../types";
import { align, type AlignContext, type AlignEvent, type Alignment } from "./align";
import { assessNumbering, numberingNote, numberingWarning, rangeWidthCap, targetElement, type LevelStats } from "./consistency";
import { QuoteChecker } from "./quote";
import { normalize } from "../../../core/text/hebrew";
import { phraseSimilarity } from "../../../matching/similarity";
import { dafElement, kindThe, kindWord, plainText, type NumberingMode, type PathElement } from "./numbering";
import { analyzeBook, buildUnits, pathKey, type BookStructure, type HeadingInfo, type Unit } from "./structure";

/*
 * The HEADINGS engine (plan stage 8.1): every commentary line inherits its structural position from
 * the headings above it (פרק › פסוק, סימן › סעיף, דף › עמוד, הלכות › הלכה, משנה…), the base book gets
 * the same tree, and each commentary content line is linked to the base line — or line range — at
 * the deepest level that matches. Pure and synchronous; see ./align.ts for the matching rules and
 * ./numbering.ts for how headings are read.
 */

export type { NumberingMode } from "./numbering";

export interface HeadingsOptions extends SefariaOwnedOption {
  /** "Conection Type" of every suggestion. Default "source" (see below). */
  readonly declaredType?: string;
  /**
   * How numerals in structural headings are read. "lenient" (default, REUSE_MATRIX §5.1): letters are
   * summed, so books that write יה / ער / רחצ still match. "strict": only canonical numerals.
   * Bare numerals with no kind word must look like numerals in both modes.
   */
  readonly numbering?: NumberingMode;
  /**
   * "(יב) …" at the start of COMMENTARY lines as the deepest level (a targum verse by verse).
   * "auto" (default): only when, section by section, the commentary's numbered lines run parallel to
   * the base's (Σmin/Σmax of the counts ≥ 0.85) — so a משנה ברורה's ס"ק numbers are never read as
   * the שולחן ערוך's סעיפים. "always" / "never" force it. The base's numbered lines are always units.
   */
  readonly inlineMarkers?: "auto" | "always" | "never";
  /** Treat short untagged lines made only of kind words and numerals ("פרק ג", "דף ב ע"א") as headings. Default true. */
  readonly untaggedHeadings?: boolean;
  readonly thresholds?: ConfidenceThresholds;
  /** Alternatives kept on each suggestion, best first. Default 3. */
  readonly maxAlternatives?: number;
  /**
   * How a line's place is found (v3 `structuralMatch` modes, F-095):
   *   "structure" (default) — the kind and number of every level of the line's path, names by similarity (v3 "structural", and more);
   *   "content"   — the TEXT of the line's own heading: the base heading with the same text (or ≥ 0.85 alike), its parent's text only a
   *                 tie-breaker; for a commentary whose numbering is not the base's but whose section names are (v3 "לפי תוכן הכותרת");
   *   "leaves"    — "structure", but only the deepest sections: a line under a heading that has sub-headings, a partial match and a
   *                 coarse target (a section with deeper units) are not proposed (v3 "רק תתי־סעיפים").
   */
  readonly headingMatch?: HeadingMatch;
  /**
   * v3 "התייחס לפסקאות רגילות כאל סעיפים" (trySplit, F-097): when a commentary heading with no sub-headings has K content lines and its
   * place in the base has exactly K sub-units (sub-headings or "(N)" lines), line k is linked to sub-unit k — an inference from the
   * counts, so never above "possible". Default false.
   */
  readonly paragraphsAsSections?: boolean;
}

export type HeadingMatch = "structure" | "content" | "leaves";
export const HEADING_MATCH_MODES: readonly HeadingMatch[] = ["structure", "content", "leaves"];

const ENGINE = "headings" as const;
/** a target range whose base section has deeper units the commentary did not address */
const RANGE_COST = 0.08;
/** a tie broken only by the book's order can never be "certain" */
const ORDER_CAP = 0.9;
const PARALLEL_MIN = 0.85;
const PROGRESS_EVERY = 500;

interface Scored {
  readonly unit: Unit;
  readonly start: number;
  readonly end: number;
  readonly path: readonly PathElement[];
  readonly score: number;
  readonly alignment: Alignment;
  /** a warning that belongs to this candidate (headingMatch "content": the heading was found under another parent) */
  readonly note?: Reason;
}

/** v3's split is an inference from the counts, not a match (trySplit: score × 0.8) */
const SPLIT_FACTOR = 0.8;
/** headingMatch "content": the heading's text found under a parent whose text differs (v3 gave the same parent a bonus instead) */
const CONTENT_OTHER_PARENT = 0.1;
const CONTENT_SIMILAR_PARENT = 0.05;
const CONTENT_SIMILAR_MIN = 0.85;

/** At least this many inline page marks make a base "paged" (as dibur-hamatchil/windows.ts pageMarks) */
const PAGE_MARKS_MIN = 20;
const PAGE_MARK_RE = /data-overlay\s*=\s*["'][^"']*Pages["'][^>]*?data-value\s*=\s*["']\d{1,3}[ab]["']/i;

/** Does the book mark its pages inside its lines (the Zohar's Vilna pages)? */
function pageMarked(book: EngineBook): boolean {
  let n = 0;
  for (const l of book.lines) if (l.text.includes("data-overlay") && PAGE_MARK_RE.test(l.text) && ++n >= PAGE_MARKS_MIN) return true;
  return false;
}

export function runHeadingsEngine(commentary: EngineBook, base: EngineBook, options: HeadingsOptions = {}, ctx: EngineContext = {}): EngineResult {
  return runToEnd(headingsSteps(commentary, base, options, ctx));
}

/** The engine as steps (../steps.ts): it yields between the books' analyses and before every commentary line. */
export function* headingsSteps(commentary: EngineBook, base: EngineBook, options: HeadingsOptions = {}, ctx: EngineContext = {}): EngineSteps<EngineResult> {
  const opts = {
    // "source": the record sits in the commentary's file and the generator stores it base → commentary,
    // which is how the app shows a commentary (compatibility review #1). "commentary" would be stored backwards.
    declaredType: options.declaredType ?? "source",
    numbering: options.numbering ?? "lenient",
    inlineMarkers: options.inlineMarkers ?? "auto",
    untaggedHeadings: options.untaggedHeadings ?? true,
    thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
    maxAlternatives: options.maxAlternatives ?? 3,
    headingMatch: options.headingMatch ?? "structure",
    paragraphsAsSections: options.paragraphsAsSections ?? false,
  };
  const notes: Reason[] = [];
  const suggestions: Suggestion[] = [];
  const unmatched: { line: number; reasons: Reason[] }[] = [];
  const aborted = () => ctx.signal?.aborted === true;
  const done = (): EngineResult => ({ suggestions, notes, unmatched });
  /**
   * No range on a base the library treats as Sefaria's — the one predicate of the export and the other
   * engines (core/links/sefaria-owned.ts): the sync remaps only the start line from ref_2, so an end
   * would drift, and a submission refuses it (validate.ts sefaria/range-side; product audit F1).
   */
  const baseRanges = !sefariaOwnedOf(options.sefariaOwned)(base.book);
  /** on a Sefaria base, which lines a record can be written to (withoutRange: the first such line of a section) */
  const block = baseRanges ? undefined : refBlockOf(base.lines);
  const sideAt = (start: number, end: number): LinkSide => {
    if (baseRanges) return sideOf(base, start, end);
    const whole = sideOf(base, start, end);
    return { book: base.book, line: firstRefIn(whole.line, whole.end ?? whole.line, block).line };
  };

  const cs = analyzeBook(commentary, opts);
  yield;
  const bs = analyzeBook(base, opts);
  yield;
  if (aborted()) return abortedResult(notes, done);
  const units = buildUnits(bs);
  const actx: AlignContext = {
    baseKinds: bs.kinds,
    baseHasNamed: bs.hasNamed,
    baseHasUnnamed: bs.markerLines > 0 || bs.headings.some((h) => h.elements.some((e) => e.kind === "?")),
    commentaryKinds: cs.kinds,
    commentaryHasNamed: cs.hasNamed,
  };
  const byKey = new Map<string, Unit[]>();
  for (const u of units) {
    const k = lastKey(u.path[u.path.length - 1]!);
    const list = byKey.get(k);
    if (list) list.push(u);
    else byKey.set(k, [u]);
  }

  const cache = new Map<string, Scored[]>();
  const match = (P: readonly PathElement[]): Scored[] => {
    const key = pathKey(P);
    const hit = cache.get(key);
    if (hit) return hit;
    const seen = new Set<Unit>();
    const scored: Scored[] = [];
    for (const e of P) {
      for (const u of byKey.get(lastKey(e)) ?? []) {
        if (seen.has(u)) continue;
        seen.add(u);
        const a = align(P, u.path, actx);
        if (!a) continue;
        const score = 1 - a.penalty - (a.missing === 0 && u.hasSubunits ? RANGE_COST : 0);
        scored.push({ unit: u, start: u.start, end: u.end, path: u.path, score: clamp(score), alignment: a });
      }
    }
    const out = rank(mergeDafSides(scored));
    cache.set(key, out);
    return out;
  };

  // the commentary's headings as sections (headingMatch "content" / "leaves", paragraphsAsSections): v3 matched headings, not lines
  const sections = commentarySections(cs);
  const content = opts.headingMatch === "content" ? contentMatcher(commentary, cs, base, bs, units) : null;
  const subunits = opts.paragraphsAsSections ? subunitsOf(bs, units) : null;
  let splits = 0;

  // inline markers on commentary lines
  const useMarkers = decideMarkers(cs, bs, units, opts.inlineMarkers, match, notes);
  structuralNotes(cs, bs, units, notes);
  // structural consistency (./consistency.ts): commentary levels whose numbers are not the base's
  const numbering = assessNumbering(cs, units, match);
  for (const s of numbering.suspect.values()) notes.push(numberingNote(s));
  /*
   * A base with no daf headings that marks its pages INSIDE its lines (the Zohar's `<i data-overlay="Vilna
   * Pages" data-value="5a">`): a commentary's "דף ה." is a page of those marks, which this engine does not
   * read — it matched the volume headings of the Zohar's appendix and the ranges around them instead
   * (library benchmark: מקדש מלך 0 of 9,639, אור החמה 0 of 19,718 right, against the database's links).
   * Lines placed by a daf are left to dibur-hamatchil, whose windows read the page marks (§3.1).
   */
  const pagedBase = !units.some((u) => u.path.some((e) => e.kind === "daf")) && pageMarked(base);
  if (pagedBase && cs.headings.some((h) => h.path.some((e) => e.kind === "daf")))
    notes.push({ code: "heading/paged-base", text: `ב"${base.book.title}" אין כותרות דף, ומספרי הדפים מסומנים בתוך השורות. שורות שהמקום שלהן נקבע לפי דף לא קושרו בשיטה הזו; דיבור המתחיל קורא את סימני הדפים.` });
  const belowHigh = opts.thresholds.high - 0.001;
  const quotes = new QuoteChecker(base, (p) => bs.lines[p]!.skip !== "heading");

  const total = commentary.lines.length;
  let skipped = 0;
  let partial = 0;
  let numberOnlyLines = 0;
  let prevStart: number | null = null;
  yield;
  for (let p = 0; p < total; p++) {
    yield;
    if (aborted()) return abortedResult(notes, done);
    if (p % PROGRESS_EVERY === 0) ctx.progress?.(p, total);
    const info = cs.lines[p]!;
    const srcIndex = commentary.lines[p]!.index;
    if (info.skip) { skipped++; continue; }
    if (pagedBase && info.path.some((e) => e.kind === "daf")) {
      unmatched.push({ line: srcIndex, reasons: [{ code: "heading/paged-base", text: "המקום של השורה נקבע לפי דף, ובספר הבסיס הדפים מסומנים בתוך השורות ולא בכותרות" }] });
      continue;
    }
    let P: readonly PathElement[] = useMarkers && info.marker !== null ? [...info.path, { kind: "?", n: info.marker, label: `(${toGematria(info.marker)})` }] : info.path;
    // a level the commentary numbers by its own count is not a place: the section above it is (consistency.ts)
    let beyond: LevelStats | undefined;
    for (let i = 1; i < P.length; i++) {
      const s = numbering.suspect.get(P[i]!.kind);
      if (P[i]!.kind !== "name" && s?.verdict === "beyond-base") {
        beyond = s;
        P = P.slice(0, i);
        break;
      }
    }
    if (!P.length) {
      unmatched.push({ line: srcIndex, reasons: [{ code: "heading/no-position", text: "השורה אינה נמצאת תחת אף כותרת, ולכן אין לה מיקום מבני" }] });
      continue;
    }
    const own = sections.headingOf[p]!;
    if (opts.headingMatch === "leaves" && own >= 0 && !sections.leaf[own]) {
      unmatched.push({ line: srcIndex, reasons: [notLeaf("commentary", cs.headings[own]!)] });
      continue;
    }
    const all = content ? (own >= 0 ? content(own) : []) : match(P);
    // A line's place must lie inside its section's place: when the section path (P without its last
    // element) is found exactly and unambiguously, candidates outside it are set aside (מכילתא דרשב"י:
    // "פרק ג › פסוק א" matched "הוספה › פרק ג › (א)" fully while "פרק ג" is the main פרק ג).
    // ("content" places a line by its heading's text and nothing else of its path.)
    const section = content ? null : sectionOf(P, match, opts.thresholds.ambiguityMargin);
    const inside = section ? all.filter((c) => c.start >= section.start && c.end <= section.end) : all;
    const outsideSection = section !== null && inside.length === 0;
    const cands = inside.length ? inside : all;
    const best0 = cands[0];
    if (!best0) {
      unmatched.push({ line: srcIndex, reasons: [{ code: "heading/not-found", text: `בספר הבסיס לא נמצא מקום המתאים ל־${describe(P)}` }] });
      continue;
    }
    // ambiguity, and a tie broken by the order of the book
    const margin = opts.thresholds.ambiguityMargin;
    const close = cands.filter((c) => best0.score - c.score < margin);
    /*
     * In a tie, a place reached by a bare number alone (see numberOnly) yields to one the line reaches by
     * more — its kind word, a name, a second number: באר הגולה "סימן יב" tied its own סימן יב (a range, so
     * 0.08 lower) with the "(יב)" lines of the appended "סדר הגט" and "סדר חליצה". Decided by this rule,
     * not by the text: never above "possible".
     */
    const real = close.filter((c) => !numberOnly(c));
    const tied = real.length && real.length < close.length ? real : close;
    const outranked = tied === real && real.length === 1;
    let chosen = tied[0]!;
    let runnerUp: number | null = tied.length > 1 ? tied[1]!.score : null;
    let orderTie = false;
    if (tied.length > 1 && prevStart !== null) {
      const following = tied.filter((c) => c.start >= prevStart!).sort((a, b) => a.start - b.start)[0];
      if (following) {
        chosen = following;
        runnerUp = null;
        orderTie = true;
      }
    }
    /*
     * A tie in which every candidate is placed by ONE number and nothing else of the line's path (its
     * sections are names or kinds the base does not have, skipped), and that number is a bare "(N)" of the
     * base, not a unit of the commentary's own kind: "פסקה מג" of ספרי, "מזמור ל" of מדרש תהילים, "חלק ג"
     * (the year) of שפת אמת, each matched to verse מג / ל / ג of every chapter of the base. The number is
     * the commentary's own count, not an address; such ties agreed with the library's links in 0.9%
     * (AUTOMATION_ENGINE.md §2, "מספר בלבד"). Not a suggestion: unmatched, counted in a note. A tie on
     * the base's own kind ("סימן א" in two חלקים) is two real places, and stays a choice ("ambiguous").
     */
    if (tied.length > 1 && !orderTie && best0.score >= opts.thresholds.possible && tied.every(numberOnly)) {
      numberOnlyLines++;
      const num = matchedOf(best0.alignment)[0]!.c!;
      unmatched.push({ line: srcIndex, reasons: [{ code: "heading/number-only", text: `רק המספר ${toGematria(num.n!)} של "${describe(P)}" נמצא בספר הבסיס, ב־${tied.length} מקומות שאין ביניהם הבדל אחר (${tied.slice(0, 3).map((c) => describe(c.path)).join("; ")}${tied.length > 3 ? "…" : ""}); מספר בלבד אינו מקום, ולכן השורה לא קושרה` }] });
      continue;
    }
    // v3 trySplit (F-097): paragraph k of a heading with no sub-headings → sub-unit k of its place, when the counts are equal
    let split: { k: number; of: number } | null = null;
    if (subunits && own >= 0 && sections.leaf[own] && !chosen.alignment.missing && chosen.unit.hasSubunits) {
      const paras = sections.paragraphs[own]!;
      const subs = subunits(chosen.unit);
      const k = paras.indexOf(p);
      if (k >= 0 && subs.length === paras.length) {
        const u = subs[k]!;
        split = { k, of: paras.length };
        chosen = { ...chosen, unit: u, start: u.start, end: u.end, path: u.path, score: chosen.score * SPLIT_FACTOR };
        splits++;
      }
    }
    if (opts.headingMatch === "leaves" && !split && (chosen.alignment.missing || chosen.unit.hasSubunits)) {
      unmatched.push({ line: srcIndex, reasons: [notLeaf("base", chosen)] });
      continue;
    }
    const el = targetElement(chosen.alignment);
    const suspect = beyond ?? (el && el.kind !== "name" ? numbering.suspect.get(el.kind) : undefined);
    let score = orderTie ? Math.min(chosen.score, ORDER_CAP) : chosen.score;
    if (split) score = Math.min(score, belowHigh);
    /*
     * The line's own heading is a NAME the base does not have, below the place that was found ("דף ב. ›
     * רבינו חננאל", "… › שאילתות פרשת צו"): an anthology's source under the daf it was gathered for, and the
     * sugya often goes on past that amud. The whole amud is the parent's place, not the line's: in קובץ
     * שיטות קמאי (5 tractates) 1,094 of the 7,859 certain the database judged were elsewhere.
     */
    const last = P[P.length - 1];
    const unplacedName = P.length > 1 && last!.kind === "name" && chosen.alignment.events.some((e) => e.code === "skip-commentary" && e.c === last);
    /*
     * The same reading with ONE place left — the only chapter long enough ("מזמור קלו" → תהילים קיט, קלו),
     * or the first of the tied places after the previous link (an order tiebreak, מלבי"ם "סימן נה") — is
     * still a number alone: never above "possible", and never the anchor of the next order tiebreak.
     */
    const loneNumber = numberOnly(chosen);
    if (suspect || outsideSection || unplacedName || loneNumber || outranked) score = Math.min(score, belowHigh);
    // the line's own quote, when it marks one, must not sit in the neighbouring stretch instead (./quote.ts)
    let quoteAt: number | null = null;
    if (score >= opts.thresholds.high) {
      const phrase = QuoteChecker.phrase(commentary.lines[p]!.text);
      const q = phrase ? quotes.check(phrase, chosen.start, chosen.end) : null;
      if (q?.verdict === "contradicted") {
        quoteAt = q.at!;
        score = Math.min(score, belowHigh);
      }
    }
    // #42 C15: a link to a whole unit is capped by the unit's width (RANGE_WIDTH)
    const span = sideOf(base, chosen.start, chosen.end);
    const wide = rangeWidthCap((span.end ?? span.line) - span.line + 1, describe(chosen.path) || "הקטע");
    if (wide) score = Math.min(score, (wide.cap === "high" ? opts.thresholds.certain : opts.thresholds.high) - 0.001);
    const confidence: Confidence = confidenceOf(score, runnerUp, opts.thresholds);
    const { reasons, warnings, rules } = explain(chosen, base, baseRanges);
    if (content) rules.push("headings.content");
    if (chosen.note) warnings.push(chosen.note);
    if (split) {
      const head = cs.headings[own]!;
      warnings.push({ code: "heading/paragraph-split", text: `תחת "${plainText(commentary.lines[head.at]!.text)}" יש ${split.of} שורות, ובספר הבסיס ${split.of} חלקים; השורה ה־${split.k + 1} קושרה לחלק ה־${split.k + 1} (${describe(chosen.path)}). זו הסקה מהספירה ולא התאמה, ולכן הביטחון הוגבל ל"אפשרית"` });
      rules.push("headings.paragraph-split");
    }
    if (wide && (confidence === "possible" || confidence === "high")) {
      warnings.push(wide.warning);
      rules.push("headings.wide-range");
    }
    if (section && inside.length && inside.length < all.length) rules.push("headings.inside-section");
    if (outsideSection) {
      warnings.push({ code: "heading/outside-section", text: `המקום שנמצא אינו בתוך המקום של הקטע שהשורה שייכת אליו (${describe(section.path)}), ולכן הביטחון הוגבל ל"אפשרית"` });
      rules.push("headings.outside-section");
    }
    if (suspect) {
      warnings.push(numberingWarning(suspect));
      rules.push("headings.numbering-suspect");
    }
    if (unplacedName) {
      warnings.push({ code: "heading/unplaced-name", text: `הכותרת של השורה ("${last!.label}") אינה בספר הבסיס, ולכן השורה קושרה לכל המקום שמעליה (${describe(chosen.path)}), והביטחון הוגבל ל"אפשרית"` });
      rules.push("headings.unplaced-name");
    }
    if (quoteAt !== null) {
      warnings.push({ code: "heading/quote-elsewhere", text: `הדיבור המתחיל של השורה לא נמצא במקום הזה, אבל נמצא סמוך אליו בספר הבסיס (שורה ${base.lines[quoteAt]!.index + 1}); ייתכן שגבולות הקטעים בשני הספרים שונים, ולכן הביטחון הוגבל ל"אפשרית"` });
      rules.push("headings.quote-elsewhere");
    }
    if (outranked) {
      warnings.push({ code: "heading/bare-number-rival", text: `${close.length - 1} מקומות נוספים התאימו רק לפי המספר, בלי סוג היחידה (שורות "(N)" בספר הבסיס); נבחר המקום שמתאים גם בסוג, והביטחון הוגבל ל"אפשרית"` });
      rules.push("headings.bare-number-rival");
    }
    if (loneNumber) {
      warnings.push({ code: "heading/number-only", text: `המקום נקבע רק לפי המספר ${toGematria(matchedOf(chosen.alignment)[0]!.c!.n!)} של "${describe(P)}", בלי שום חלק אחר של המיקום (מספור של הפירוש עצמו נראה כך), ולכן הביטחון הוגבל ל"אפשרית"` });
      rules.push("headings.number-only");
    }
    if (orderTie) {
      warnings.push({ code: "heading/order-tiebreak", text: `נמצאו ${tied.length} מקומות מתאימים בספר הבסיס; נבחר הראשון שאחרי הקישור הקודם, לפי סדר הספר` });
      rules.push("headings.order-tiebreak");
    } else if (confidence === "ambiguous") {
      warnings.push({ code: "heading/ambiguous", text: `נמצאו ${tied.length} מקומות מתאימים באותה מידה בספר הבסיס` });
    }
    if (confidence === "none") {
      unmatched.push({ line: srcIndex, reasons: [{ code: "heading/weak", text: `ההתאמה הטובה ביותר (${describe(chosen.path)}) חלשה מדי` }, ...warnings] });
      continue;
    }
    if (chosen.alignment.missing) partial++;
    if (confidence === "certain" || confidence === "high") prevStart = chosen.start;
    // on a Sefaria base: the section's first line that can carry a record, with the section kept as citedSpan (withoutRange)
    const whole = sideOf(base, chosen.start, chosen.end);
    const { target, citedSpan, lines: each, reason: firstRef } = baseRanges ? { target: whole, citedSpan: undefined, lines: undefined, reason: undefined } : withoutRange(whole, block);
    if (firstRef) {
      // a record per line is not "the section's start only" (explain's heading/range-sefaria)
      if (each) reasons.splice(0, reasons.length, ...reasons.filter((x) => x.code !== "heading/range-sefaria"));
      reasons.push(firstRef);
      rules.push(each ? "headings.each-line" : "headings.first-ref");
    }
    const capped = capSpanned(confidence, citedSpan);
    if (capped.warning) warnings.push(capped.warning);
    const source: LinkSide = { book: commentary.book, line: srcIndex };
    const heRef2 = heRefOf(base, chosen);
    suggestions.push({
      id: suggestionId(commentary, srcIndex, target),
      engine: ENGINE,
      source,
      target,
      ...(citedSpan && { citedSpan }),
      // every written line has a heRef (it carries a ref_2: sefaria-owned.ts refBlockOf)
      ...(each && { spanLines: each.map((l) => ({ line: l, heRef2: lineAt(base, l)?.heRef ?? heRef2 })) }),
      declaredType: opts.declaredType,
      heRef2,
      score: round(score),
      confidence: capped.confidence,
      reasons,
      rules,
      alternatives: cands
        .filter((c) => c !== chosen)
        .slice(0, opts.maxAlternatives)
        .map((c): Candidate => ({ target: sideAt(c.start, c.end), score: round(c.score), reasons: explain(c, base, baseRanges).reasons })),
      warnings,
    });
  }
  ctx.progress?.(total, total);
  if (skipped) notes.push({ code: "heading/skipped-lines", text: `${skipped} שורות בפירוש דולגו: כותרות, שורות ריקות או שורות עם פחות משתי אותיות עבריות` });
  if (numberOnlyLines) notes.push({ code: "heading/number-only", text: `${numberOnlyLines} שורות לא קושרו: רק מספר אחד שלהן נמצא בספר הבסיס, בכמה מקומות שאין ביניהם הבדל אחר (מספור של הפירוש עצמו, כמו "פסקה" או "חלק", מול מספרי פסוקים או סעיפים בכל פרק)` });
  if (partial) notes.push({ code: "heading/partial-matches", text: `${partial} שורות קושרו רק לרמה גבוהה יותר (למשל לפרק כולו), כי הרמה העמוקה שלהן לא נמצאה בספר הבסיס` });
  if (splits) notes.push({ code: "heading/paragraph-split", text: `${splits} שורות קושרו כ"פסקאות כסעיפים": מספר השורות תחת הכותרת שווה למספר החלקים בספר הבסיס, והשורה ה־k קושרה לחלק ה־k. בדקו אותן לפני אישור` });
  if (content) notes.push({ code: "heading/content-mode", text: "המקום של כל שורה נקבע לפי הטקסט של הכותרת שמעליה, ולא לפי המספרים שבכותרות" });
  return done();
}

/** The commentary's headings as sections: the heading each line sits under, whether it has sub-headings, and its content lines. */
interface CommentarySections {
  /** per position in book.lines: index into cs.headings of the nearest heading above (the deepest of its path), or -1 */
  readonly headingOf: readonly number[];
  /** per heading: no sub-heading below it (v3 "כותרת־עלה") */
  readonly leaf: readonly boolean[];
  /** per heading: the positions of its content lines, up to the next heading line of any level (v3 paragraphLines) */
  readonly paragraphs: readonly (readonly number[])[];
}

function commentarySections(cs: BookStructure): CommentarySections {
  const hs = cs.headings;
  const leaf = hs.map((h, i) => i + 1 >= hs.length || hs[i + 1]!.level <= h.level);
  const headingOf: number[] = [];
  const paragraphs: number[][] = hs.map(() => []);
  let h = -1;
  let open = false; // no heading line since heading h
  for (let p = 0; p < cs.lines.length; p++) {
    while (h + 1 < hs.length && hs[h + 1]!.at <= p) (h++, (open = true));
    const l = cs.lines[p]!;
    if (l.skip === "heading") {
      if (h < 0 || hs[h]!.at !== p) open = false; // a heading line with no elements (a title) closes the paragraphs too
      headingOf.push(h);
      continue;
    }
    headingOf.push(h);
    if (h >= 0 && open && l.skip === null) paragraphs[h]!.push(p);
  }
  return { headingOf, leaf, paragraphs };
}

/** The direct sub-units of a base unit, in order: its next-level sub-headings, else its "(N)" lines (v3 `t.children`). */
function subunitsOf(bs: BookStructure, units: readonly Unit[]): (u: Unit) => Unit[] {
  const own = new Map<number, Unit>();
  for (const u of units) if (u.headingAt !== null && !u.marker && !own.has(u.headingAt)) own.set(u.headingAt, u);
  const idx = new Map(bs.headings.map((h, i) => [h.at, i] as const));
  const cache = new Map<number, Unit[]>();
  return (u) => {
    const hit = cache.get(u.id);
    if (hit) return hit;
    let out: Unit[] = [];
    const i = u.headingAt === null || u.marker ? undefined : idx.get(u.headingAt);
    if (i !== undefined && own.get(u.headingAt!) === u) {
      const lv = bs.headings[i]!.level;
      const below: HeadingInfo[] = [];
      for (let k = i + 1; k < bs.headings.length && bs.headings[k]!.level > lv; k++) below.push(bs.headings[k]!);
      const top = Math.min(...below.map((h) => h.level));
      out = below.filter((h) => h.level === top).map((h) => own.get(h.at)).filter((x): x is Unit => x !== undefined);
    }
    if (!out.length && !u.marker) out = units.filter((m) => m.marker && m.parent === u.id);
    cache.set(u.id, out);
    return out;
  };
}

/**
 * headingMatch "content" (v3 `_contentScore`): the base headings whose TEXT is the text of the line's heading (1), or alike by at least
 * CONTENT_SIMILAR_MIN (never 1), each as the unit it heads. The parent's text breaks ties: another parent costs CONTENT_OTHER_PARENT
 * (alike: CONTENT_SIMILAR_PARENT), so an exact text under another parent is "high", never "certain". Cached per heading.
 */
function contentMatcher(commentary: EngineBook, cs: BookStructure, base: EngineBook, bs: BookStructure, units: readonly Unit[]): (h: number) => Scored[] {
  const textOf = (b: EngineBook, at: number) => normalize(plainText(b.lines[at]!.text));
  const labelOf = (b: EngineBook, at: number) => plainText(b.lines[at]!.text);
  const parentOf = (hs: readonly HeadingInfo[], i: number): number | null => {
    for (let k = i - 1; k >= 0; k--) if (hs[k]!.level < hs[i]!.level) return k;
    return null;
  };
  const own = new Map<number, Unit>();
  for (const u of units) if (u.headingAt !== null && !u.marker && !own.has(u.headingAt)) own.set(u.headingAt, u);
  const entries = bs.headings.flatMap((h, i) => {
    const unit = own.get(h.at);
    if (!unit) return [];
    const parent = parentOf(bs.headings, i);
    return [{ unit, text: textOf(base, h.at), label: labelOf(base, h.at), parent: parent === null ? null : textOf(base, bs.headings[parent]!.at), parentLabel: parent === null ? null : labelOf(base, bs.headings[parent]!.at) }];
  });
  const byText = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = byText.get(e.text);
    if (list) list.push(e);
    else byText.set(e.text, [e]);
  }
  const cache = new Map<number, Scored[]>();
  return (h) => {
    const hit = cache.get(h);
    if (hit) return hit;
    const head = cs.headings[h]!;
    const text = textOf(commentary, head.at);
    const label = labelOf(commentary, head.at);
    const pi = parentOf(cs.headings, h);
    const parent = pi === null ? null : textOf(commentary, cs.headings[pi]!.at);
    const parentLabel = pi === null ? null : labelOf(commentary, cs.headings[pi]!.at);
    let found = (byText.get(text) ?? []).map((e) => ({ e, sim: 1 }));
    if (!found.length && text)
      found = entries
        .filter((e) => Math.abs(e.text.length - text.length) <= Math.max(3, text.length * 0.3))
        .map((e) => ({ e, sim: phraseSimilarity(text, e.text) }))
        .filter((x) => x.sim >= CONTENT_SIMILAR_MIN);
    const c: PathElement = { kind: "name", name: text, label };
    const scored = found.map(({ e, sim }): Scored => {
      const b: PathElement = { kind: "name", name: e.text, label: e.label };
      let cost = sim === 1 ? 0 : 1 - sim * 0.95;
      let note: Reason | undefined;
      if (parent !== e.parent) {
        const alike = parent !== null && e.parent !== null && phraseSimilarity(parent, e.parent) >= CONTENT_SIMILAR_MIN;
        cost += alike ? CONTENT_SIMILAR_PARENT : CONTENT_OTHER_PARENT;
        note = { code: "heading/content-other-parent", text: `הכותרת "${label}" נמצאה בספר הבסיס ${e.parentLabel !== null ? `תחת "${e.parentLabel}"` : "בלי כותרת מעליה"}, ${parentLabel !== null ? `ובפירוש היא תחת "${parentLabel}"` : "ובפירוש אין כותרת מעליה"}` };
      }
      const alignment: Alignment = { penalty: cost, events: [sim === 1 ? { code: "same-name", c, b } : { code: "similar-name", c, b, sim }], missing: 0 };
      const score = clamp(1 - cost - (e.unit.hasSubunits ? RANGE_COST : 0));
      return { unit: e.unit, start: e.unit.start, end: e.unit.end, path: e.unit.path, score, alignment, ...(note && { note }) };
    });
    const out = rank(scored);
    cache.set(h, out);
    return out;
  };
}

/** Why a line is not linked under headingMatch "leaves". */
function notLeaf(side: "commentary" | "base", x: HeadingInfo | Scored): Reason {
  if (side === "commentary") return { code: "heading/not-leaf", text: "השורה נמצאת תחת כותרת שיש תחתיה כותרות נוספות; בהגדרה \"רק תתי־סעיפים\" מקשרים רק שורות שתחת הכותרת העמוקה ביותר" };
  const s = x as Scored;
  return {
    code: "heading/not-leaf",
    text: s.alignment.missing
      ? `הרמה העמוקה של השורה לא נמצאה בספר הבסיס, ונמצא רק ${describe(s.path)}; בהגדרה "רק תתי־סעיפים" לא מקשרים לקטע שלם`
      : `בספר הבסיס ${describe(s.path)} מחולק לחלקים קטנים יותר; בהגדרה "רק תתי־סעיפים" לא מקשרים לקטע שלם`,
  };
}

/** The base place of the line's section (its path without the last element), when exact and unambiguous. */
function sectionOf(P: readonly PathElement[], match: (P: readonly PathElement[]) => Scored[], margin: number): Scored | null {
  if (P.length < 2) return null;
  const cands = match(P.slice(0, -1));
  const top = cands[0];
  if (!top || top.alignment.missing) return null;
  const rival = cands[1];
  if (rival && top.score - rival.score < margin) return null;
  return top;
}

/** the events that matched something of both paths (not skips, not the missing tail) */
function matchedOf(a: Alignment): AlignEvent[] {
  return a.events.filter((e) => e.code !== "skip-commentary" && e.code !== "skip-base" && e.code !== "missing");
}

/**
 * The candidate rests on one number of the line's path and on nothing else — no name, no daf, no second
 * number — and that number met a bare "(N)" of the base (align.ts "inline-number"), not a unit of its kind.
 */
function numberOnly(c: Scored): boolean {
  const m = matchedOf(c.alignment);
  return m.length === 1 && m[0]!.code === "inline-number";
}

function abortedResult(notes: Reason[], done: () => EngineResult): EngineResult {
  notes.push({ code: "engine/aborted", text: "הריצה הופסקה לבקשת המשתמש; התוצאות חלקיות" });
  return done();
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const round = (x: number) => Math.round(x * 1000) / 1000;

export function lastKey(e: PathElement): string {
  if (e.kind === "name") return "$";
  if (e.kind === "daf") return `d${e.n}`;
  return `#${e.n}`;
}

function rank(list: Scored[]): Scored[] {
  // one entry per target, best score first, then document order
  const byTarget = new Map<string, Scored>();
  for (const s of list) {
    const k = `${s.start}-${s.end}`;
    const prev = byTarget.get(k);
    if (!prev || s.score > prev.score || (s.score === prev.score && s.path.length > prev.path.length)) byTarget.set(k, s);
  }
  return [...byTarget.values()].sort((a, b) => b.score - a.score || a.start - b.start);
}

/** "דף ב" with no amud matched both "דף ב." and "דף ב:" — one candidate over both sides (REUSE §5.12). */
function mergeDafSides(list: Scored[]): Scored[] {
  const groups = new Map<string, Scored[]>();
  const rest: Scored[] = [];
  for (const s of list) {
    const ev = s.alignment.events.find((e) => e.code === "daf-both-amudim");
    const last = s.path[s.path.length - 1]!;
    if (!ev || last.kind !== "daf") { rest.push(s); continue; }
    const k = `${pathKey(s.path.slice(0, -1))}|${last.n}`;
    const g = groups.get(k);
    if (g) g.push(s);
    else groups.set(k, [s]);
  }
  for (const g of groups.values()) {
    if (g.length === 1) { rest.push(g[0]!); continue; }
    const first = g.reduce((a, b) => (a.start <= b.start ? a : b));
    const last = g[g.length - 1]!.path[g[g.length - 1]!.path.length - 1]!;
    rest.push({
      ...first,
      start: Math.min(...g.map((s) => s.start)),
      end: Math.max(...g.map((s) => s.end)),
      path: [...first.path.slice(0, -1), dafElement(last.n!, undefined)],
      score: Math.min(...g.map((s) => s.score)),
    });
  }
  return rest;
}

function decideMarkers(
  cs: BookStructure,
  bs: BookStructure,
  units: readonly Unit[],
  mode: "auto" | "always" | "never",
  match: (P: readonly PathElement[]) => Scored[],
  notes: Reason[],
): boolean {
  if (!cs.markerLines || mode === "never") return false;
  if (mode === "always") return true;
  if (!bs.markerLines) {
    notes.push({ code: "heading/markers-unused", text: "בפירוש יש שורות ממוספרות בסוגריים, אבל בספר הבסיס אין, ולכן הקישור הוא לפי הכותרות בלבד" });
    return false;
  }
  const markersOfUnit = new Map<number, number>();
  for (const u of units) if (u.marker && u.parent !== null) markersOfUnit.set(u.parent, (markersOfUnit.get(u.parent) ?? 0) + 1);
  const sections = new Map<string, { path: readonly PathElement[]; markers: Set<number> }>();
  for (const l of cs.lines) {
    if (!l.markerLine || !l.path.length) continue;
    const k = pathKey(l.path);
    const s = sections.get(k) ?? { path: l.path, markers: new Set<number>() };
    s.markers.add(l.marker!);
    sections.set(k, s);
  }
  let sumMin = 0;
  let sumMax = 0;
  for (const s of sections.values()) {
    const best = match(s.path).find((c) => c.alignment.missing === 0 && !c.unit.marker);
    const m = best ? markersOfUnit.get(best.unit.id) ?? 0 : 0;
    const k = s.markers.size;
    sumMin += Math.min(k, m);
    sumMax += Math.max(k, m);
  }
  const ratio = sumMax ? sumMin / sumMax : 0;
  const pct = Math.round(ratio * 100);
  if (ratio >= PARALLEL_MIN) {
    notes.push({ code: "heading/markers-parallel", text: `השורות הממוספרות בסוגריים בפירוש מקבילות לאלה שבספר הבסיס (${pct}%), ולכן כל שורה מקושרת לשורה בעלת אותו מספר` });
    return true;
  }
  notes.push({ code: "heading/markers-not-parallel", text: `המספור בסוגריים בפירוש אינו מקביל למספור בספר הבסיס (${pct}% התאמה), ולכן הקישור הוא לפי הכותרות בלבד` });
  return false;
}

function structuralNotes(cs: BookStructure, bs: BookStructure, units: readonly Unit[], notes: Reason[]): void {
  const seq = (s: BookStructure) => {
    let restarts = 0;
    let gaps = 0;
    let gapExample = "";
    const last = new Map<string, { v: number; label: string }>();
    for (const h of s.headings) {
      const e = h.path[h.path.length - 1];
      if (!e || e.kind === "name" || e.kind === "?") continue;
      const k = `${pathKey(h.path.slice(0, -1))}|${e.kind}`;
      const v = e.kind === "daf" ? e.n! * 2 + (e.amud === 2 ? 1 : 0) : e.n!;
      const prev = last.get(k);
      if (prev) {
        if (v <= prev.v) restarts++;
        else if (e.kind !== "daf" && v > prev.v + 1) {
          gaps++;
          if (!gapExample) gapExample = `${e.label} אחרי ${prev.label}`;
        }
      }
      last.set(k, { v, label: e.label });
    }
    return { restarts, gaps, gapExample };
  };
  const c = seq(cs);
  const b = seq(bs);
  if (c.restarts) notes.push({ code: "heading/commentary-restarts", text: `בפירוש יש ${c.restarts} כותרות שמספרן אינו גדול מזה של הכותרת שלפניהן (מספור מתחיל מחדש או כפול)` });
  if (b.restarts) notes.push({ code: "heading/base-restarts", text: `בספר הבסיס יש ${b.restarts} כותרות שמספרן אינו גדול מזה של הכותרת שלפניהן; מיקומים כפולים יסומנו כעמומים` });
  if (b.gaps) notes.push({ code: "heading/base-gaps", text: `בספר הבסיס חסרים מספרים ב־${b.gaps} מקומות (למשל ${b.gapExample}); ייתכן שחסרות בו כותרות` });
  const dup = new Map<string, number>();
  for (const u of units) if (!u.marker && u.headingAt !== null) dup.set(u.pathKey, (dup.get(u.pathKey) ?? 0) + 1);
  const dups = [...dup.values()].filter((v) => v > 1).length;
  if (dups) notes.push({ code: "heading/base-duplicates", text: `בספר הבסיס ${dups} מיקומים מופיעים יותר מפעם אחת` });
  if (cs.untagged || bs.untagged) notes.push({ code: "heading/untagged", text: `זוהו כותרות בלי תגית כותרת: ${cs.untagged} בפירוש ו־${bs.untagged} בספר הבסיס` });
  if (!cs.headings.length) notes.push({ code: "heading/commentary-no-headings", text: "בפירוש אין כותרות, ולכן אי אפשר לקשר אותו לפי כותרות" });
  if (!bs.headings.length) notes.push({ code: "heading/base-no-headings", text: "בספר הבסיס אין כותרות, ולכן אי אפשר לקשר אליו לפי כותרות" });
}

/** the line with this index (lines are in order, usually one per index) */
function lineAt(book: EngineBook, index: number): EngineBook["lines"][number] | undefined {
  const l = book.lines[index];
  return l?.index === index ? l : book.lines.find((x) => x.index === index);
}

function sideOf(book: EngineBook, start: number, end: number): LinkSide {
  const s = book.lines[start]!.index;
  const e = book.lines[end]!.index;
  return e > s ? { book: book.book, line: s, end: e } : { book: book.book, line: s };
}

function suggestionId(commentary: EngineBook, srcLine: number, target: LinkSide): string {
  return `${ENGINE}:${commentary.book.key}:${srcLine}>${target.book.key}:${target.line}${target.end !== undefined ? `-${target.end}` : ""}`;
}

function heRefOf(base: EngineBook, s: Scored): string {
  const single = s.unit.marker || s.start === s.end;
  const ref = single ? base.lines[s.start]!.heRef : null;
  if (ref) return ref;
  return `${base.book.title} ${s.path.map(display).join(", ")}`.trim();
}

function display(e: PathElement): string {
  if (e.kind === "?") return toGematria(e.n!);
  return e.label;
}

const describe = (P: readonly PathElement[]) => P.map(display).join(", ");

function explain(s: Scored, base: EngineBook, ranges = true): { reasons: Reason[]; warnings: Reason[]; rules: string[] } {
  const reasons: Reason[] = [];
  const warnings: Reason[] = [];
  const rules = new Set<string>();
  const evs = s.alignment.events;
  for (const ev of evs) {
    const r = eventReason(ev);
    if (!r) continue;
    (r.warning ? warnings : reasons).push({ code: r.code, text: r.text });
  }
  const skipped = evs.some((e) => e.code === "skip-base" || e.code === "skip-commentary");
  rules.add(s.alignment.missing ? "headings.path-partial" : skipped ? "headings.path-skip" : "headings.path-exact");
  if (evs.some((e) => e.code === "inline-number")) rules.add("headings.inline-number");
  if (evs.some((e) => e.code === "daf-both-amudim")) rules.add("headings.daf-both-amudim");
  if (s.alignment.missing) {
    const firstMissing = evs.find((e) => e.code === "missing")!.c!;
    warnings.push({
      code: "heading/partial",
      text: `${display(firstMissing)} לא נמצא בספר הבסיס תחת ${describe(s.path)}; הקישור הוא ל${describe(s.path)} כולו`,
    });
  }
  if (s.end > s.start && !s.unit.marker && !ranges) {
    // a Sefaria base: the link goes to the section's first line, with no range end
    reasons.push({ code: "heading/range-sefaria", text: `הקישור לתחילת ${describe(s.path)} בלבד: זה ספר של ספריא, והספרייה לא מקבלת טווח בצד שלו` });
  } else if (s.end > s.start && !s.unit.marker) {
    rules.add("headings.range");
    const from = base.lines[s.start]!.index + 1;
    const to = base.lines[s.end]!.index + 1;
    reasons.push({ code: "heading/range-target", text: `הקישור לכל התוכן של ${describe(s.path)} (שורות ${from}–${to}), בלי שורת הכותרת` });
    if (s.unit.hasSubunits && !s.alignment.missing) {
      warnings.push({ code: "heading/coarse-target", text: `בספר הבסיס ${describe(s.path)} מחולק לחלקים קטנים יותר, ובפירוש אין חלוקה כזו; הקישור הוא לכל הקטע` });
    }
  }
  if ((s.unit.marker || s.start === s.end) && base.lines[s.start]!.heRef) rules.add("headings.base-heref");
  return { reasons, warnings, rules: [...rules] };
}

function eventReason(ev: AlignEvent): { code: string; text: string; warning?: boolean } | null {
  const c = ev.c;
  const b = ev.b;
  switch (ev.code) {
    case "same-number":
      if (c!.kind !== b!.kind) return { code: "heading/same-number", text: `"${c!.label}" הוא "${b!.label}" בספר הבסיס (${kindWord(c!.kind)} ו${kindWord(b!.kind)} הם אותה יחידה)` };
      return { code: "heading/same-number", text: `מספר ${kindThe(c!.kind)} תואם (${toGematria(c!.n!)})` };
    case "inline-number": {
      const g = toGematria(c!.n!);
      if (c!.kind === "?" && b!.kind === "?") return { code: "heading/inline-number", text: `המספר בסוגריים (${g}) זהה בשני הספרים` };
      if (b!.kind === "?") return { code: "heading/inline-number", text: `מספר ${kindThe(c!.kind)} (${g}) תואם לשורה הממוספרת (${g}) בספר הבסיס` };
      return { code: "heading/inline-number", text: `המספר (${g}) תואם ל${kindWord(b!.kind) || "מספר"} ${g} בספר הבסיס` };
    }
    case "same-name":
      return { code: "heading/same-name", text: `שם הכותרת זהה (${c!.label})` };
    case "similar-name":
      return { code: "heading/similar-name", text: `שם הכותרת דומה: "${c!.label}" ו"${b!.label}"` };
    case "daf-amud":
      return { code: "heading/same-daf", text: `הדף והעמוד תואמים (${b!.label})` };
    case "daf-both-amudim":
      return { code: "heading/daf-both-amudim", text: `הדף תואם (${c!.label}); בפירוש לא צוין עמוד, ולכן הקישור לשני העמודים` };
    case "daf-coarse":
      return { code: "heading/daf-coarse", text: `בפירוש צוין ${c!.label}, אבל בספר הבסיס יש כותרת לדף כולו בלבד`, warning: true };
    case "skip-commentary":
      return { code: "heading/skipped-commentary-level", text: `הכותרת "${c!.label}" אינה קיימת בספר הבסיס ודולגה`, warning: true };
    case "skip-base":
      return { code: "heading/skipped-base-level", text: `בספר הבסיס יש רמה נוספת ("${b!.label}") שאין בפירוש`, warning: true };
    case "missing":
      return null;
  }
}
