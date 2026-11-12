/*
 * The Dibur Hamatchil engine (plan stage 8.2): for every line of a commentary, find the base line
 * its ד"ה quotes. Core ported from otzaria-link-generator `runLinkingParser` (parserAlgorithm.ts
 * @7ad8b2c) — continuous weighted search, the A–D flexibility ladder, the unique (single-word)
 * anchor, בא"ד/שם inheritance and the calibrated confidence — without its React state, its
 * secondary-source routing (רש"י/תוספות as extra targets) or its mirror tables: this engine links
 * ONE commentary to ONE base, inside windows the caller may supply.
 *
 * Output direction (docs/research/DH_ANCHOR_DIRECTION.md):
 *   • default shape — source = commentary line, target = base line(s), type "source" (the record
 *     the library expects in the commentary's own links file; the generator flips it into a
 *     COMMENTARY link base→commentary). It can carry no anchor: a flipped record loses `start`.
 *   • anchored shape — when both books are local Otzaria books and the stored form does not
 *     flip: source = base line(s) with an anchor on the ד"ה words, target = commentary line, type
 *     "commentary" (a record of the BASE book's links file). Stored identically, plus the anchor.
 * One shape per run; `result.notes` says which and why.
 */
import type { BookRef, LinkSide, RawAnchor } from "../../../core/links/model";
import { storedForm } from "../../../core/links/stored-form";
import { skeleton, stem } from "../../../core/text/hebrew";
import { approximateOccurrence } from "../../../matching/similarity";
import { headingLevel, stripTags } from "../../../core/text/html";
import { hebrewTokens, visibleSlice, type HebToken } from "../../../matching/hebrew-tokens";
import { acronymInitials, initialsKeys, startsOf, StepVocabulary, stepProfiler, stepTable, type StepProfile, type StepTable } from "../../../matching/token-match";
import { idfFactors, STOP_WORDS, wordWeight } from "../../../matching/word-weights";
import {
  confidenceOf,
  DEFAULT_THRESHOLDS,
  type Candidate,
  type ConfidenceThresholds,
  type EngineBook,
  type EngineContext,
  type EngineLine,
  type EngineResult,
  type Reason,
  type Suggestion,
} from "../types";
import { inheritedConfidence, matchConfidence, dynamicMinThreshold, type MatchEvidence, type Rung } from "./confidence";
import { DEFAULT_MAX_DH_WORDS, extractDh, leadingMarkerTokens, type ExtractedDh } from "./extract";
import { bestRun, orderFactor, qualifyingOccurrence, STRICT_SPEC, type Run, type SearchSpec } from "./search";
import { baseMarkers, openingNoteNumbers, type CommentatorMarkers } from "./markers";
import { commentatorOfTitle, type Commentator } from "./addressee";
import { headingWindowPlan, widen, type SearchWindow } from "./windows";

export interface DhOptions {
  /** base line range (0-based, inclusive) to search for a commentary line; null → the engine's own default */
  readonly windows?: (commentaryLine: number) => { from: number; to: number } | null;
  /** cap on ד"ה words (12, as the source) */
  readonly maxDhWords?: number;
  readonly thresholds?: ConfidenceThresholds;
  /** "auto" (default): anchor the base words when that record shape survives the generator; "off": never */
  readonly anchors?: "auto" | "off";
  /** the base lines open with their own ד"ה (e.g. רש"י as the base of a super-commentary); default: detected */
  readonly targetStartsWithDh?: boolean;
  /** a one-word anchor may open at most this share of the commentary's lines (0.008, as the source) */
  readonly singleWordMaxOpeningRatio?: number;
  /** relax the search step by step for a line that marks its ד"ה explicitly (default true) */
  readonly ladder?: boolean;
  /**
   * also search the neighbouring sections (rungs C and D of the ladder). Default false: measured on
   * 51 commentary–base pairs of the real database (REAL_DATA_REPORT.md §7), a ד"ה found only outside
   * its own section was right 154 times in 797, and never in the held-out sample.
   */
  readonly ladderWide?: boolean;
  /** בא"ד / שם lines take the previous line's place (default true) */
  readonly inherit?: boolean;
  /**
   * a line that quotes an intermediate commentator ("רש"י ד"ה X", "<b>תוס'</b> בד"ה X", and the lines
   * that continue it) is linked only to that commentator's book, never to the text it comments on
   * (default true; requirements §2)
   */
  readonly intermediates?: boolean;
  /**
   * when the base is an intermediate commentator: link ONLY the lines that quote it by name ("רש"י ד"ה
   * X", "תוס' בד"ה X", and the בא"ד lines after them). Off by default — a commentary written on רש"י
   * itself (שפתי חכמים) names no one and is all about it. The max-link planner turns it on for the
   * step from a commentary on a text to the other commentators on that text (plan.ts intermediateSteps):
   * without it every unlabeled line was searched in the commentator's words and matched wherever both
   * quote the same verse or Gemara (library benchmark, 2026-11-12: ~87K suggestions in pairs the
   * database never links, "אבן עזרא על תהילים" → "רש"י על תהילים", "רש"י על חולין" → "ריטב"א על חולין").
   * "cap": every line is searched, but one that does not name the commentator is left for review
   * (possible at most, dh/not-addressed-cap): for a pair the database already links (plan.ts
   * siblingRelations), where a book on רש"י names it on few lines ("גור אריה", "מזרחי") and a book on the
   * Gemara names it on the lines that are about it (מהרש"א, מהר"ם שיף).
   */
  readonly addressedOnly?: boolean | "cap";
  /**
   * a paragraph without a ד"ה of its own (no bold opening) after a ד"ה line of the same section belongs
   * to that ד"ה's place, in a book whose ד"ה lines are bold and whose sections hold few of them
   * (default true; the "item" of build_artzot_hachaim_links.py)
   */
  readonly continueItems?: boolean;
  /** drop or demote what does not fit the order of the whole commentary (default true; see "the order of the whole commentary" in the engine) */
  readonly order?: boolean;
  /**
   * "Conection Type" of every suggestion, instead of the default pair ("commentary" base → commentary
   * with an anchor, "source" commentary → base without one). The max-link planner sets
   * "mishnah_in_talmud" for a Mishnah tractate and its Bavli (linking/plan.ts). A type the generator
   * would flip or downgrade in the direction a record is written is not used for that record: the
   * default stays (recordTypes).
   */
  readonly declaredType?: string;
}

const r = (code: string, text: string): Reason => ({ code, text });

const BOUNDARY_REASON: Readonly<Record<string, Reason>> = {
  bold: r("dh/boundary-bold", "הדיבור המתחיל מודגש בשורת הפירוש"),
  etc: r("dh/boundary-etc", 'הדיבור המתחיל מסתיים ב"וכו\'"'),
  punctuation: r("dh/boundary-punctuation", "הדיבור המתחיל מסתיים בנקודה או בנקודתיים"),
  dash: r("dh/boundary-dash", "הדיבור המתחיל מסתיים במקף"),
  none: r("dh/boundary-none", "בשורה אין סימן לסוף הדיבור המתחיל, ולכן נבדקו המילים הראשונות שלה"),
};
const COLOPHON_RE = /^(?:\s|<[^>]*>)*(?:סליק|סליקו|תם ונשלם|נשלם|תמו ונשלמו|ותשלם)(?![\u05d0-\u05ea])/;
const RUNG_TEXT: Readonly<Record<Rung, string>> = {
  A: "נמצא רק אחרי הקלה בחיפוש (שלב א: גם באמצע שורת הבסיס)",
  B: "נמצא רק אחרי הקלה בחיפוש (שלב ב: בלי משקל לפי נדירות המילים)",
  C: "נמצא רק אחרי הקלה בחיפוש (שלב ג: גם בקטעים הסמוכים)",
  D: "נמצא רק אחרי הקלה בחיפוש (שלב ד: בסף התאמה נמוך)",
  L: "נמצא רק בהשוואת האותיות (מרחק עריכה), כי המילים עצמן לא נמצאו ברצף",
};

/**
 * The placements that lie on one heaviest chain whose base lines never go back (a commentary follows
 * its base): a weighted longest non-decreasing subsequence over (commentary order, base line), weight =
 * the placement's score, by a Fenwick tree of prefix maxima. Returns the commentary lines on it.
 */
export function monotoneChain(items: readonly { readonly cLine: number; readonly base: number; readonly score: number }[]): Set<number> {
  const out = new Set<number>();
  if (!items.length) return out;
  const lines = [...new Set(items.map((x) => x.base))].sort((a, b) => a - b);
  const rank = new Map(lines.map((l, i) => [l, i + 1]));
  const m = lines.length;
  const treeVal = new Float64Array(m + 1);
  const treeAt = new Int32Array(m + 1).fill(-1);
  const best = new Float64Array(items.length);
  const prevOf = new Int32Array(items.length);
  items.forEach((x, k) => {
    let v = 0;
    let at = -1;
    for (let q = rank.get(x.base)!; q > 0; q -= q & -q)
      if (treeVal[q]! > v) {
        v = treeVal[q]!;
        at = treeAt[q]!;
      }
    best[k] = v + x.score;
    prevOf[k] = at;
    for (let q = rank.get(x.base)!; q <= m; q += q & -q)
      if (best[k]! > treeVal[q]!) {
        treeVal[q] = best[k]!;
        treeAt[q] = k;
      }
  });
  let k = 0;
  for (let i = 1; i < items.length; i++) if (best[i]! > best[k]!) k = i;
  for (; k !== -1; k = prevOf[k]!) out.add(items[k]!.cLine);
  return out;
}

/** First index of `arr` whose element is not `below` (`below` holds for a prefix of `arr`). */
function lowerBound(arr: readonly number[], below: (v: number) => boolean): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (below(arr[mid]!)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const BOLD_LINE_RE = /^\s*(?:[([][^)\]<]{0,8}[)\]]\s*)?<(b|strong)\b/i;
const NOTE_RE = /class\s*=\s*["']?footnote/i;
/** addressedOnly "cap": a book names the base's commentator when this many of its ד"ה lines do… */
const NAMES_MIN = 5;
/** …and this share of them */
const NAMES_SHARE = 0.05;

/** A placement of one commentary line on the base, before it is shaped into a Suggestion. */
interface Placement {
  readonly cLine: number;
  readonly base: number;
  readonly baseEnd?: number;
  /** raw offsets of the matched ד"ה words in the base line */
  readonly words?: { rawStart: number; rawEnd: number };
  readonly score: number;
  readonly confidence: ReturnType<typeof confidenceOf>;
  readonly reasons: Reason[];
  readonly rules: string[];
  readonly warnings: Reason[];
  readonly alternatives: { line: number; score: number }[];
  /** score of the directly matched link at the head of an inheritance chain */
  readonly rootScore: number;
  readonly depth: number;
}

interface Cand {
  readonly pos: number;
  readonly line: number;
  readonly run: Run;
  readonly exact: boolean;
  readonly matchedWeight: number;
  readonly windowWeight: number;
  readonly rank: number;
  readonly lineTokens: number;
  readonly contLine: number | null;
  /** the run is the base line's own lemma head (a ד"ה-style base: רש"י, תוספות, a ש"ך…) */
  readonly lemmaHead: boolean;
}

/**
 * The type each record shape is written with: the declared type when the generator stores it as written
 * in that direction (not flipped, not downgraded to OTHER), else the default of the shape. A type outside
 * the generator's oriented set (SOURCE_VIEW_TYPES — "mishnah_in_talmud", "reference"…) is always kept.
 */
export function recordTypes(commentary: BookRef, base: BookRef, declared?: string): { anchored: string; plain: string } {
  const keeps = (source: BookRef, target: BookRef, t: string) => {
    const f = storedForm({ source: { book: source, line: 0 }, target: { book: target, line: 0 }, declaredType: t });
    return f.knownType && !f.flipped && !f.downgraded;
  };
  const t = declared?.trim();
  return {
    anchored: t && keeps(base, commentary, t) ? t : "commentary",
    plain: t && keeps(commentary, base, t) ? t : "source",
  };
}

/** Which record shape can carry an anchor on the base words (see DH_ANCHOR_DIRECTION.md). */
export function anchorPolicy(commentary: BookRef, base: BookRef, mode: "auto" | "off" = "auto", anchoredType = "commentary"): { anchors: boolean; reason: Reason } {
  if (mode === "off") return { anchors: false, reason: r("dh/anchors-off", "עוגנים כובו בהגדרות, ולכן כל הקישורים נכתבים מצד הפירוש.") };
  if (commentary.origin !== "otzaria" || base.origin !== "otzaria") {
    const sefaria = commentary.origin === "sefaria" || base.origin === "sefaria";
    return {
      anchors: false,
      reason: sefaria
        ? r("dh/anchors-sefaria", "אחד הספרים הוא ספר ספריא. עוגן על מילים מקובץ קישורים אינו נתמך בקישור כזה, ולכן הקישורים נכתבים מצד הפירוש ובלי עוגן.")
        : r("dh/anchors-origin", "אחד הספרים אינו ספר מספריית אוצריא, ולא ידוע אם עוגן ישרוד את הייבוא. הקישורים נכתבים מצד הפירוש ובלי עוגן."),
    };
  }
  const f = storedForm({ source: { book: base, line: 0 }, target: { book: commentary, line: 0 }, declaredType: anchoredType });
  if (f.flipped || f.downgraded || f.skipped)
    return { anchors: false, reason: r("dh/anchors-flip", "במבנה הזה אוצריא הייתה הופכת את כיוון הקישור, והעוגן היה נזרק. הקישורים נכתבים מצד הפירוש ובלי עוגן.") };
  return {
    anchors: true,
    reason: r("dh/anchors-base", `הקישורים נכתבים מצד ספר הבסיס (${anchoredType === "commentary" ? "כקישור פירוש" : `כקישור מסוג "${anchoredType}"`}), עם עוגן על מילות הדיבור המתחיל. הם שייכים לקובץ הקישורים של ספר הבסיס.`),
  };
}

/**
 * Runs the engine. Pure and synchronous over the given lines; cooperative: checks `ctx.signal`
 * before every commentary line and reports progress every 25 lines. An aborted run returns what it
 * found so far, with an "engine/aborted" note.
 */
export function runDiburHamatchilEngine(commentary: EngineBook, base: EngineBook, options: DhOptions = {}, ctx: EngineContext = {}): EngineResult {
  const maxWords = options.maxDhWords ?? DEFAULT_MAX_DH_WORDS;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const maxRatio = options.singleWordMaxOpeningRatio ?? 0.008;
  const useLadder = options.ladder !== false;
  const ladderWide = options.ladderWide === true;
  const inherit = options.inherit !== false;
  const types = recordTypes(commentary.book, base.book, options.declaredType);
  const policy = anchorPolicy(commentary.book, base.book, options.anchors ?? "auto", types.anchored);
  const notes: Reason[] = [policy.reason];
  const routeIntermediates = options.intermediates !== false;
  const continueItems = options.continueItems !== false;
  /** the intermediate commentator the base book is (רש"י על …, תוספות על …), else null */
  const baseIs: Commentator | null = commentatorOfTitle(base.book.title);

  // ── base preparation ──────────────────────────────────────────────────────────────────────
  const bLines = base.lines;
  const posOf = new Map<number, number>();
  bLines.forEach((l, i) => posOf.set(l.index, i));
  const bHeading = bLines.map((l) => (l.heading ?? headingLevel(l.text)) !== null);
  const bTokens: HebToken[][] = bLines.map((l, i) => {
    if (bHeading[i]) return [];
    const t = hebrewTokens(l.text);
    return t.slice(leadingMarkerTokens(l.text, t)); // a verse number "(יז)" is not a word of the text
  });
  // step profiles of the base words (search.ts bestRun: the cheap test before matchStep), one profiler per run
  const stepProfile = stepProfiler();
  const bProfiles: StepProfile[][] = bTokens.map((t) => t.map((x) => stepProfile(x.key)));
  const bTables: (StepTable | undefined)[] = [];
  const tableOf = (p: number): StepTable => (bTables[p] ??= stepTable(bTokens[p]!, bProfiles[p]!));
  const cExtract = new Map<number, ExtractedDh>();
  for (const l of commentary.lines) cExtract.set(l.index, extractDh(l, maxWords));
  /*
   * addressedOnly "cap": a book that names the base's commentator on its lines (מהרש"א, ערוך לנר: "תוד"ה …"
   * on a fifth to a third of them) tells which lines are about it, and the others are about the text — as
   * addressedOnly; searching them too pushed correct lines out of the order (ערוך לנר על יבמות → רש"י:
   * 321 → 272 of the database's links). A book that hardly ever names it (מזרחי, גור אריה: under 1%) is
   * about it throughout: every line is searched, and the unnamed ones are left for review.
   */
  let dhLines = 0;
  let naming = 0;
  for (const e of cExtract.values())
    if (e.kind === "dh") {
      dhLines++;
      if (e.addressee?.kind === "named" && e.addressee.commentator.key === baseIs?.key) naming++;
    }
  const names = naming >= NAMES_MIN && naming >= NAMES_SHARE * dhLines;
  const addressedOnly = options.addressedOnly === true || (options.addressedOnly === "cap" && names);
  /** addressedOnly "cap", in a book that does not name the commentator: its lines (capped to possible) */
  const unaddressed = options.addressedOnly === "cap" && !names && baseIs ? new Set<number>() : null;
  if (options.addressedOnly === "cap" && baseIs)
    notes.push(
      names
        ? r("dh/addressed-labels", `הפירוש מזכיר את ${baseIs.name} בשמו ב־${naming} מתוך ${dhLines} שורות דיבור המתחיל, ולכן רק השורות האלה (וההמשך שלהן) מחופשות בדבריו.`)
        : r("dh/addressed-rarely", `הפירוש כמעט אינו מזכיר את ${baseIs.name} בשמו (${naming} מתוך ${dhLines} שורות), ולכן הוא כתוב עליו כולו: כל שורה מחופשת בדבריו, ושורה שאינה מזכירה אותו נשארת לבדיקה.`),
    );
  /*
   * Item paragraphs (continueItems): a book whose ד"ה lines open with bold, and whose sections hold few
   * of them — the median section (with any) has at most 3 — writes one ד"ה per item and continues it in
   * plain paragraphs (ארץ יהודה on ארצות החיים: a ס"ק heading, a bold ד"ה, then up to 20 paragraphs).
   * Measured on the 51 pairs (REAL_DATA_REPORT.md §7.2): such a paragraph, not found by its own words,
   * belonged to the place of the strong bold ד"ה above it in 514 of 530.
   */
  const itemBook = (() => {
    const perSection: number[] = [];
    let n = 0;
    for (const l of commentary.lines) {
      const e = cExtract.get(l.index)!;
      if (e.kind === "heading") {
        if (n) perSection.push(n);
        n = 0;
      } else if (e.bold) n++;
    }
    if (n) perSection.push(n);
    perSection.sort((a, b) => a - b);
    return perSection.length > 0 && perSection[Math.floor((perSection.length - 1) / 2)]! <= 3;
  })();
  const idf = idfFactors([...bTokens.map((t) => t.map((x) => x.key)), ...[...cExtract.values()].map((e) => e.tokens.map((x) => x.key))]);
  const weightIdf = (k: string) => wordWeight(k, idf);
  const weightStatic = (k: string) => wordWeight(k);

  const contentPositions = bLines.map((_, i) => i).filter((i) => !bHeading[i] && bTokens[i]!.length);

  /*
   * Where each word of the base occurs, by vocabulary entry (token-match.ts StepVocabulary):
   * position × TOKEN_SLOTS + token index, ascending. The first words of a ד"ה are looked up here —
   * only the base words a step could start at, inside the window — instead of trying them against
   * every word of every line of the window, which was most of the engine's time (profiles of
   * "שער הציון ← משנה ברורה" and "אור פנימי", 2026-11-11). bestRun gets exactly the starts it
   * would have found itself (a superset of them, checked again by matchStep).
   */
  const TOKEN_SLOTS = 1 << 20;
  const vocab = new StepVocabulary(stepProfile);
  const postings: number[][] = [];
  // the initials of each word and the next (an acronym of the ד"ה is spelled there); the next word may
  // be the next line's first, when a run may continue there
  const initials = new Map<string, number[]>();
  for (const p of contentPositions) {
    const toks = bTokens[p]!;
    const nextLine = bLines[p + 1]?.index === bLines[p]!.index + 1 && !bHeading[p + 1] ? bTokens[p + 1]![0] : undefined;
    toks.forEach((t, i) => {
      const at = p * TOKEN_SLOTS + i;
      const e = vocab.add(t);
      (postings[e] ??= []).push(at);
      for (const k of initialsKeys(t, toks[i + 1] ?? nextLine)) {
        const list = initials.get(k);
        if (list) list.push(at);
        else initials.set(k, [at]);
      }
    });
  }
  /** For each of the first `n` words of `src`: base position → token indexes where a step may start, positions pFrom..pTo. */
  const startsIn = (src: readonly HebToken[], n: number, pFrom: number, pTo: number): Map<number, number[]>[] =>
    src.slice(0, n).map((x, s0) => {
      const byPos = new Map<number, number[]>();
      const lo = pFrom * TOKEN_SLOTS;
      const hi = (pTo + 1) * TOKEN_SLOTS;
      const lists = vocab.compatible(x, src[s0 + 1]).map((e) => postings[e]);
      const spelled = acronymInitials(x);
      for (const k of spelled) lists.push(initials.get(k));
      // only an acronym can reach one word twice (by its entry and by its initials)
      const seen = spelled.length ? new Set<number>() : null;
      for (const list of lists) {
        if (!list) continue;
        for (let i = lowerBound(list, (v) => v < lo); i < list.length && list[i]! < hi; i++) {
          if (seen) {
            if (seen.has(list[i]!)) continue;
            seen.add(list[i]!);
          }
          const p = Math.floor(list[i]! / TOKEN_SLOTS);
          const at = list[i]! - p * TOKEN_SLOTS;
          const ts = byPos.get(p);
          if (ts) ts.push(at);
          else byPos.set(p, [at]);
        }
      }
      for (const ts of byPos.values()) if (ts.length > 1) ts.sort((a, b) => a - b);
      return byPos;
    });
  const startsWithDh =
    options.targetStartsWithDh ?? (contentPositions.length > 0 && contentPositions.filter((i) => BOLD_LINE_RE.test(bLines[i]!.text)).length / contentPositions.length >= 0.6);
  const strict: SearchSpec = { ...STRICT_SPEC, requireTargetStart: startsWithDh };
  /** words of a base line's own lemma (its opening bold run), 0 when it has none */
  const lemmaLen: (number | undefined)[] = [];
  const lemmaOf = (pos: number): number => {
    let n = lemmaLen[pos];
    if (n === undefined) {
      const e = extractDh(bLines[pos]!, 24);
      // the base tokens drop a leading verse/item number; so does extractDh
      n = lemmaLen[pos] = e.kind === "dh" && e.boundary === "bold" ? e.dh.length + Math.max(0, e.from - leadingMarkerTokens(bLines[pos]!.text, e.tokens)) : 0;
    }
    return n;
  };

  // inverted index for wide windows (built on first use)
  let keyIndex: Map<string, number[]> | null = null;
  const indexKey = (k: string) => skeleton(stem(k));
  const buildIndex = () => {
    keyIndex = new Map();
    const add = (k: string, p: number) => {
      const a = keyIndex!.get(k);
      if (!a) keyIndex!.set(k, [p]);
      else if (a.at(-1) !== p) a.push(p);
    };
    bTokens.forEach((toks, p) => toks.forEach((t) => (add(t.key, p), add(`~${indexKey(t.key)}`, p))));
    return keyIndex;
  };

  // heRef of a line: the database's, else title + the heading path above it
  const headingPath = (book: EngineBook) => {
    const out = new Map<number, string>();
    const stack: { level: number; text: string }[] = [];
    for (const l of book.lines) {
      const level = l.heading ?? headingLevel(l.text);
      if (level !== null) {
        while (stack.length && stack.at(-1)!.level >= level) stack.pop();
        const text = stripTags(l.text);
        if (text && text !== book.book.title) stack.push({ level, text });
      }
      out.set(l.index, stack.length ? `${book.book.title}, ${stack.map((s) => s.text).join(", ")}` : book.book.title);
    }
    return out;
  };
  const bPath = headingPath(base);
  const cPath = headingPath(commentary);
  const heRefOf = (book: EngineBook, paths: Map<number, string>, line: EngineLine | undefined, index: number) =>
    line?.heRef?.trim() || paths.get(index) || book.book.title;

  // opening words of the commentary (rarity gate of the single-word anchor)
  const openings = new Map<string, number>();
  let contentLines = 0;
  for (const e of cExtract.values()) {
    if (e.kind !== "dh") continue;
    contentLines++;
    const k = e.dh[0]!.key;
    openings.set(k, (openings.get(k) ?? 0) + 1);
  }
  const openingRatio = (k: string) => (contentLines ? (openings.get(k) ?? 0) / contentLines : 1);

  // windows
  const plan = headingWindowPlan(commentary, base);
  const defaultWindows = plan.windowOf;
  if (plan.distrusted && !options.windows)
    notes.push(
      r(
        "dh/headings-distrusted",
        `כותרות הפירוש (${plan.distrusted.matched.slice(0, 3).join(", ")}) נמצאו בספר הבסיס רק בתוך הקטע "${plan.distrusted.section}", שהפירוש אינו מזכיר. המבנה של שני הספרים שונה, ולכן החיפוש נעשה בכל ספר הבסיס, לפי סדר ההתקדמות של הפירוש.`,
      ),
    );
  for (const o of plan.ownNumbering ?? [])
    if (!options.windows)
      notes.push(
        r(
          "dh/own-numbering",
          `ה"${o.kind}" של הפירוש הוא מספור משלו, לא של שורות הבסיס: ב־${o.exceeding} מתוך ${o.sections} קטעים המספר הגבוה בפירוש גדול מהמספר הגבוה בבסיס. לכן שורות תחת "${o.kind}" מחופשות בכל הקטע שמעליו, ולא רק בשורה בעלת אותו מספר.`,
        ),
      );
  const first = bLines[0]?.index ?? 0;
  const last = bLines.at(-1)?.index ?? 0;
  const windowFor = (cLine: number): SearchWindow => {
    const w = options.windows?.(cLine);
    if (w) return { from: Math.max(first, Math.min(w.from, w.to)), to: Math.min(last, Math.max(w.from, w.to)), kind: "caller" };
    return defaultWindows(cLine);
  };
  /*
   * The commentary's note markers in the base (markers.ts). The commentator with about as many
   * numbered markers as the commentary has numbered lines, whose markers fit the numbers the lines
   * open with — inside each line's window — for at least half of them (and 5), is this commentary;
   * its numbered lines are then placed on their markers, not by the words they quote.
   */
  const noteNumbers = new Map<number, number[]>();
  for (const l of commentary.lines) {
    if (cExtract.get(l.index)!.kind === "heading") continue;
    const ns = openingNoteNumbers(l.text);
    if (ns.length) noteNumbers.set(l.index, ns);
  }
  const markersIn = (m: CommentatorMarkers, n: number, w: SearchWindow): readonly number[] => (m.byNumber.get(n) ?? []).filter((i) => i >= w.from && i <= w.to);
  let noteMarkers: CommentatorMarkers | null = null;
  {
    const sets = noteNumbers.size ? baseMarkers(bLines) : [];
    let best = 0;
    for (const m of sets) {
      // every note has one marker: a commentator with far more or far fewer markers than the
      // commentary has numbered lines is another book's notes ("Ohr Penimi": 400 markers for
      // 1,000+ numbered lines; a book with two commentators' markers, 1,100 and 119)
      let count = 0;
      for (const at of m.byNumber.values()) count += at.length;
      if (count * 2 < noteNumbers.size || count > noteNumbers.size * 2) continue;
      let fit = 0;
      for (const [line, ns] of noteNumbers) if (ns.some((n) => markersIn(m, n, windowFor(line)).length)) fit++;
      if (fit > best) [best, noteMarkers] = [fit, m];
    }
    if (best < 5 || best * 2 < noteNumbers.size) noteMarkers = null;
    else
      notes.push(
        r(
          "dh/note-markers",
          `בספר הבסיס יש סימני הערות של "${noteMarkers!.commentator}" שמתאימים למספרים שבראש שורות הפירוש (${best} מתוך ${noteNumbers.size}). הערה ממוספרת מקושרת למקום הסימן שלה, ולא למקום שבו נמצאו המילים שהיא מצטטת.`,
        ),
      );
  }

  /*
   * Lines a ד"ה can land on (contentPositions, ascending) by base line index. A window is a SPAN of
   * that array, found by binary search — never a scan of the window: with the whole book as the
   * window (no matching headings) a scan per phase and per rung cost O(base) for every commentary
   * line, and "שער הציון ← משנה ברורה" (18,680 × 18,119 lines) spent minutes on it alone.
   */
  const positionsIn = (from: number, to: number, among: readonly number[] = contentPositions): readonly number[] =>
    among.slice(lowerBound(among, (p) => bLines[p]!.index < from), lowerBound(among, (p) => bLines[p]!.index <= to));
  /**
   * Positions holding one of the first `n` words of the ד"ה (or a word with the same stem skeleton),
   * ascending — the candidates of a wide window. The same for every phase and every rung of a line,
   * so it is computed once per ד"ה.
   */
  const hitsCache = new WeakMap<readonly HebToken[], Map<number, number[]>>();
  const hitsOf = (src: readonly HebToken[], n: number): readonly number[] => {
    let byN = hitsCache.get(src);
    if (!byN) hitsCache.set(src, (byN = new Map()));
    let out = byN.get(n);
    if (!out) {
      const ix = keyIndex ?? buildIndex();
      const hits = new Set<number>();
      for (const t of src.slice(0, n)) {
        for (const p of ix.get(t.key) ?? []) hits.add(p);
        for (const p of ix.get(`~${indexKey(t.key)}`) ?? []) hits.add(p);
      }
      out = [...hits].sort((a, b) => a - b);
      byN.set(n, out);
    }
    return out;
  };

  /*
   * Runs already measured for the current commentary line. A line is searched by up to three phases
   * (near the previous match, a little further, the whole window) and, when nothing is found, by the
   * ladder rungs A–D; the phases overlap and rung C/D re-search rung B's window with B's spec (D only
   * lowers the bar, which bestRun does not see). Without this every phase and rung measured the same
   * base lines again. Keyed by base position, the spec (minus `multiplier`) and whether the next base
   * line was joined on; cleared for every commentary line.
   */
  const specIds = new Map<string, number>();
  const specId = (spec: SearchSpec): number => {
    const k = `${spec.maxStartIdx}|${spec.shallowLimit}|${spec.deepMinRun}|${spec.requireTargetStart}|${spec.useIdf}|${spec.fuzzy}`;
    let id = specIds.get(k);
    if (id === undefined) specIds.set(k, (id = specIds.size));
    return id;
  };
  type RunCache = Map<number, Run | null>;
  const cachedRun = (cache: RunCache, key: number, measure: () => Run | null): Run | null => {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const run = measure();
    cache.set(key, run);
    return run;
  };

  // ── one search pass over a window ─────────────────────────────────────────────────────────
  const searchPass = (ex: ExtractedDh, window: SearchWindow, prev: number | null, spec: SearchSpec, runs: RunCache, startsCache: Map<string, Map<number, number[]>[]>): Cand[] => {
    const src = ex.dh;
    const w = spec.useIdf ? weightIdf : weightStatic;
    const srcW = src.map((t) => w(t.key));
    const forWeight = ex.explicit ? src : ex.tokens.slice(ex.from);
    const expected = forWeight.reduce((s, t) => s + w(t.key), 0);
    const windowWeight = forWeight.slice(0, maxWords).reduce((s, t) => s + w(t.key), 0);
    const threshold = dynamicMinThreshold(expected, forWeight.length, ex.explicit, spec.multiplier);
    const fullCredit = srcW.reduce((s, x) => s + x, 0);
    const sid = specId(spec) * 2;
    // where the first words of the ד"ה may start a run in this window — the same for every phase and spec
    const pFrom = contentPositions[lowerBound(contentPositions, (p) => bLines[p]!.index < window.from)] ?? bLines.length;
    const pTo = contentPositions[lowerBound(contentPositions, (p) => bLines[p]!.index <= window.to) - 1] ?? -1;
    const startsKey = `${spec.maxStartIdx}:${pFrom}-${pTo}`;
    let starts = startsCache.get(startsKey);
    if (!starts) startsCache.set(startsKey, (starts = startsIn(src, Math.min(spec.maxStartIdx, src.length), pFrom, pTo)));
    const startsHere = starts;
    const none: readonly number[] = [];
    const contSpec: SearchSpec = { ...spec, maxStartIdx: 2, shallowLimit: Number.MAX_SAFE_INTEGER, deepMinRun: 0, requireTargetStart: false };
    const contSid = specId(contSpec) * 2 + 1;

    const phases: [number, number][] = [];
    if (prev !== null) {
      phases.push([Math.max(window.from, prev - 12), Math.min(window.to, prev + 12)]);
      if (window.kind === "book") phases.push([Math.max(window.from, prev - 30), Math.min(window.to, prev + 300)]);
    }
    phases.push([window.from, window.to]);

    // Phases run from the previous match outwards. A phase whose best is a verbatim hit of an
    // explicit ד"ה ends the search; otherwise the next phase runs too and its candidates join, so
    // one wrong placement cannot trap every following line near it.
    const found = new Map<number, Cand>();
    const ranked = () => {
      const dist = (c: Cand) => (prev === null ? c.line : c.line >= prev ? c.line - prev : 1e6 + prev - c.line);
      return [...found.values()].sort((a, b) => b.rank - a.rank || dist(a) - dist(b) || a.line - b.line);
    };
    for (const [from, to] of phases) {
      let positions = positionsIn(from, to);
      if (positions.length > 400) positions = positionsIn(from, to, hitsOf(src, spec.maxStartIdx + 1));
      for (const p of positions) {
        if (found.has(p)) continue;
        // no word of the line can start a run, so bestRun would find none (and no verbatim hit either)
        if (!startsHere.some((m) => m.has(p))) continue;
        const line = bLines[p]!;
        const tg = bTokens[p]!;
        const next = bLines[p + 1];
        const joinNext = next && next.index === line.index + 1 && next.index <= window.to && !bHeading[p + 1] && bTokens[p + 1]!.length;

        let run: Run | null = null;
        let exact = false;
        if (ex.explicit) {
          const at = qualifyingOccurrence(src, tg, spec);
          if (at >= 0) {
            exact = true;
            run = { score: fullCredit, simSum: src.length, srcStart: 0, srcUsed: src.length, tgtStart: at, tgtEnd: at + src.length, steps: src.length, kinds: new Set(["exact"]) };
          }
        }
        run ??= cachedRun(runs, (p * 64 + sid) * 2 + (joinNext ? 1 : 0), () => bestRun(src, srcW, tg, w, spec, tg.length, (s0) => startsHere[s0]!.get(p) ?? none, joinNext ? bTokens[p + 1]! : undefined));
        if (!run || run.score < threshold) continue;
        // a common short phrase must not match alone
        const used = src.slice(run.srcStart, run.srcStart + run.srcUsed);
        if (!used.some((t) => !STOP_WORDS.has(t.key) && t.key.length >= 3) && !used.some((t) => t.acronym)) continue;

        let matchedWeight = run.score;
        let ww = windowWeight;
        let contLine: number | null = null;
        if (ex.continuation.length >= 2) {
          const cw = ex.continuation.map((t) => w(t.key));
          const contProfiles = ex.continuation.map((t) => stepProfile(t.key));
          const buf: number[] = [];
          let bestCont: { score: number; line: number } | null = null;
          for (let q = p; q < Math.min(bLines.length, p + 11) && bLines[q]!.index <= window.to; q++) {
            if (bHeading[q] || !bTokens[q]!.length) continue;
            const cr = cachedRun(runs, (q * 64 + contSid) * 2, () => bestRun(ex.continuation, cw, bTokens[q]!, w, contSpec, bTokens[q]!.length, (s0) => startsOf(ex.continuation[s0]!, contProfiles[s0]!, tableOf(q), bTokens[q]!.length, buf)));
            if (cr && cr.steps >= 2 && cr.score >= 0.4 && (!bestCont || cr.score > bestCont.score)) bestCont = { score: cr.score, line: bLines[q]!.index };
          }
          if (bestCont) {
            matchedWeight += bestCont.score;
            ww += cw.reduce((s, x) => s + x, 0);
            contLine = bestCont.line;
          }
        }
        /*
         * A base whose lines open with their own lemma (רש"י, תוספות, a ש"ך): a run from the line's first
         * word over most of that lemma IS the quoted lemma (the owner's lemma_head_match.py: "align the
         * dibur's leading words against each candidate's own lemma head"). The evidence is then measured
         * against the lemma, not against the whole commentary line, which marks no ד"ה boundary.
         */
        let lemmaHead = false;
        if (startsWithDh && run.tgtStart === 0 && !ex.explicit) {
          const head = lemmaOf(p);
          const covered = Math.min(run.tgtEnd, head);
          if (head > 0 && covered >= Math.min(head, 2) && covered * 10 >= head * 6 && run.steps >= Math.min(2, src.length)) {
            lemmaHead = true;
            ww = Math.min(ww, tg.slice(0, head).reduce((s, t) => s + w(t.key), 0));
          }
        }
        const rank = ((exact ? 10 : 0) + matchedWeight) * orderFactor(line.index, prev);
        found.set(p, { pos: p, line: line.index, run, exact, matchedWeight, windowWeight: ww, rank, lineTokens: tg.length, contLine, lemmaHead });
      }
      const best = ranked()[0];
      if (best && (best.exact || !ex.explicit)) return ranked();
    }
    return ranked();
  };

  // ── the single-word / few-word unique anchor ─────────────────────────────────────────────
  const uniqueAnchor = (ex: ExtractedDh, window: SearchWindow): { cand: Cand; n: number } | null => {
    const words = ex.dh;
    for (let n = Math.min(3, words.length); n >= (ex.explicit ? 1 : 2); n--) {
      const anchor = words.slice(0, n);
      if (anchor.reduce((s, t) => s + t.key.length, 0) < 3) continue;
      if (n === 1 && (STOP_WORDS.has(anchor[0]!.key) || openingRatio(anchor[0]!.key) > maxRatio)) continue;
      let hit = -1;
      let at = -1;
      let hits = 0;
      // a qualifying occurrence holds the anchor's first word verbatim: only lines indexed under it
      const holders = (keyIndex ?? buildIndex()).get(anchor[0]!.key) ?? [];
      for (const p of positionsIn(window.from, window.to, holders)) {
        const a = qualifyingOccurrence(anchor, bTokens[p]!, { ...strict, shallowLimit: Number.MAX_SAFE_INTEGER });
        if (a < 0) continue;
        if (++hits > 1) break;
        hit = p;
        at = a;
      }
      if (hits !== 1) continue;
      const anchorWeight = anchor.reduce((s, t) => s + weightIdf(t.key), 0);
      const windowWeight = words.slice(0, maxWords).reduce((s, t) => s + weightIdf(t.key), 0) || anchorWeight;
      const run: Run = { score: anchorWeight, simSum: n, srcStart: 0, srcUsed: n, tgtStart: at, tgtEnd: at + n, steps: n, kinds: new Set(["exact"]) };
      return {
        n,
        cand: { pos: hit, line: bLines[hit]!.index, run, exact: n > 1, matchedWeight: anchorWeight, windowWeight, rank: anchorWeight, lineTokens: bTokens[hit]!.length, contLine: null, lemmaHead: false },
      };
    }
    return null;
  };

  /*
   * Rung L: the ד"ה as one string of letters, found by edit distance (approximateOccurrence) inside
   * the stretch of a base line around a word it shares with the ד"ה — the owner's "Levenshtein ≤ 34%"
   * (build_artzot_hachaim_links.py), for quotations whose words drifted beyond what a word step
   * bridges. Only an explicit ד"ה of 8+ letters, only inside a structural window of at most 300 lines
   * (a page, a seif, a section — never the whole book), only base lines holding one of its words (the
   * inverted index), and only a clear winner: the best line at least 2 edits better than any other.
   */
  const letterRung = (ex: ExtractedDh, window: SearchWindow): Cand | null => {
    if (window.kind === "book" || window.to - window.from > 300) return null;
    const src = ex.dh;
    const pattern = src.map((t) => t.key).join("");
    if (src.length < 2 || pattern.length < 8) return null;
    const max = Math.floor(pattern.length * 0.34);
    const keys = new Set(src.filter((t) => t.key.length >= 3 && !STOP_WORDS.has(t.key)).flatMap((t) => [t.key, `~${indexKey(t.key)}`]));
    if (!keys.size) return null;
    // a small window is read whole; a larger one only where a word of the ד"ה (or its stem skeleton) stands
    const all = positionsIn(window.from, window.to);
    const whole = all.length <= 60;
    const positions = whole ? all : positionsIn(window.from, window.to, hitsOf(src.filter((t) => t.key.length >= 3 && !STOP_WORDS.has(t.key)), src.length));
    if (positions.length > 200) return null;
    let best: { pos: number; dist: number; from: number; to: number } | null = null;
    let second = Infinity;
    for (const pos of positions) {
      const tg = bTokens[pos]!;
      let lineBest: { dist: number; from: number; to: number } | null = null;
      const segments: [number, number][] = [];
      for (let i = 0; i < tg.length; i++)
        if (keys.has(tg[i]!.key) || keys.has(`~${indexKey(tg[i]!.key)}`)) segments.push([Math.max(0, i - src.length - 1), Math.min(tg.length, i + src.length + 2)]);
      if (!segments.length && whole && tg.reduce((n, t) => n + t.key.length, 0) <= 800) segments.push([0, tg.length]);
      for (const [from, to] of segments) {
        const seg = tg.slice(from, to);
        const hit = approximateOccurrence(pattern, seg.map((t) => t.key).join(""), max);
        if (!hit || (lineBest && hit.dist >= lineBest.dist)) continue;
        // the token where the occurrence ends, and the ד"ה's length in words back from it
        let letters = 0;
        let endTok = from;
        for (let k = from; k < to && letters < hit.end; k++) (letters += tg[k]!.key.length), (endTok = k + 1);
        lineBest = { dist: hit.dist, from: Math.max(from, endTok - src.length), to: endTok };
      }
      if (!lineBest) continue;
      if (!best || lineBest.dist < best.dist) {
        if (best) second = Math.min(second, best.dist);
        best = { pos, ...lineBest };
      } else second = Math.min(second, lineBest.dist);
    }
    if (!best || second - best.dist < 2) return null;
    const sim = 1 - best.dist / pattern.length;
    const ww = src.reduce((s, t) => s + weightIdf(t.key), 0);
    const run: Run = { score: sim * ww, simSum: sim * src.length, srcStart: 0, srcUsed: src.length, tgtStart: best.from, tgtEnd: best.to, steps: src.length, kinds: new Set(["fuzzy"]) };
    return { pos: best.pos, line: bLines[best.pos]!.index, run, exact: false, matchedWeight: sim * ww, windowWeight: ww, rank: sim * ww, lineTokens: bTokens[best.pos]!.length, contLine: null, lemmaHead: false };
  };

  const evidenceOf = (c: Cand, runnerUp: number): MatchEvidence => ({
    matchedWeight: c.matchedWeight,
    windowWeight: c.windowWeight,
    runWords: c.run.steps,
    simSum: c.run.simSum,
    winnerScore: c.rank,
    runnerUpScore: runnerUp,
    exactPhrase: c.exact,
  });

  /** Places one ד"ה line, or explains why not. */
  const placeDh = (ex0: ExtractedDh, cLine: EngineLine, prev: number | null): Placement | Reason[] => {
    let ex = ex0;
    const window0 = windowFor(cLine.index);
    // "(סעיף ה')" before the quote: the seif the base numbers itself, inside the section
    const window = (ex.unit?.kind === "סעיף" ? plan.unitOf(window0, ex.unit.n) : null) ?? window0;
    const prevIn = prev !== null && prev >= window.from && prev <= window.to ? prev : null;
    let rung: Rung | null = null;
    const runs: RunCache = new Map();
    const startsCache = new Map<string, Map<number, number[]>[]>();
    let cands: Cand[] = [];
    // a one- or two-word bold run that the line's punctuation continues: the longer quote first
    if (ex.extended.length) {
      const longer: ExtractedDh = { ...ex, dh: ex.extended, boundary: "punctuation", text: visibleSlice(cLine.text, ex.extended[0]!.rawStart, ex.extended.at(-1)!.rawEnd) };
      cands = searchPass(longer, window, prevIn, strict, runs, new Map());
      if (cands.length) ex = longer;
    }
    if (!cands.length) cands = searchPass(ex, window, prevIn, strict, runs, startsCache);
    if (!cands.length && ex.explicit && useLadder) {
      const A: SearchSpec = { ...strict, requireTargetStart: false, deepMinRun: 2 };
      const B: SearchSpec = { ...A, useIdf: false };
      const D: SearchSpec = { ...B, multiplier: 0.4 };
      const wide = widen(window, base);
      const rungs = [["A", A, window], ["B", B, window], ["C", B, wide], ["D", D, wide]] as const;
      for (const [rg, spec, win] of ladderWide ? rungs : rungs.slice(0, 2)) {
        cands = searchPass(ex, win, prevIn, spec, runs, startsCache);
        if (cands.length) {
          rung = rg;
          break;
        }
      }
    }
    let uniqueN = 0;
    if (!cands.length) {
      const u = uniqueAnchor(ex, window);
      if (u) {
        cands = [u.cand];
        uniqueN = u.n;
      }
    }
    if (!cands.length && ex.explicit && useLadder) {
      const l = letterRung(ex, window);
      if (l) {
        cands = [l];
        rung = "L";
      }
    }
    if (!cands.length)
      return [r("dh/not-found", `הדיבור המתחיל "${ex.text}" לא נמצא בטווח החיפוש (שורות ${window.from + 1}–${window.to + 1} בספר הבסיס)`), r(`dh/window-${window.kind}`, window.label ? `טווח החיפוש: "${window.label}"` : "טווח החיפוש: כל ספר הבסיס")];

    const win = cands[0]!;
    const rivals = cands.slice(1, 4);
    const score = matchConfidence({ evidence: evidenceOf(win, rivals[0]?.rank ?? 0), explicit: ex.explicit || win.lemmaHead, rung });
    // every rival is scored on its own measured evidence, against the winner as ITS rival — two
    // verbatim occurrences then score alike and the result is reported as ambiguous (the source
    // kept the verbatim flag for the winner only, which hid exactly these ties)
    const alternatives = rivals.map((c) => ({ line: c.line, score: matchConfidence({ evidence: evidenceOf(c, win.rank), explicit: ex.explicit || c.lemmaHead, rung }) }));
    alternatives.sort((a, b) => b.score - a.score);
    const confidence = confidenceOf(score, alternatives[0]?.score ?? null, thresholds);
    // A weak match BEFORE the previous line's place is mostly wrong: the commentary moves forward, and
    // a weak backward hit is usually an earlier occurrence of common words. Measured (51 real pairs):
    // "possible"/"ambiguous" backward matches were right 212 times in 1,080. Strong ones stay
    // (certain 112/122), with their "dh/backward" warning.
    if (prevIn !== null && win.line < prevIn && (confidence === "possible" || confidence === "ambiguous"))
      return [r("dh/backward-weak", `נמצאה התאמה חלשה רק לפני המקום של השורה הקודמת (שורה ${win.line + 1} בספר הבסיס, והקודמת בשורה ${prevIn + 1}); התאמה כזו שגויה ברוב המקרים, ולכן לא הוצעה`)];

    const reasons: Reason[] = [BOUNDARY_REASON[ex.boundary]!];
    const rules = [`dh/extract-${ex.boundary}`, `dh/window-${window.kind}`];
    const warnings: Reason[] = [];
    const kinds = win.run.kinds;
    const firstLineEnd = Math.min(win.run.tgtEnd, win.lineTokens);
    const tg = bTokens[win.pos]!;
    if (win.lemmaHead) {
      rules.push("dh/lemma-head");
      reasons.push(r("dh/lemma-head", "המילים נמצאו בראש שורת הבסיס, בדיבור המתחיל שלה עצמה"));
    }
    if (ex !== ex0) {
      rules.push("dh/extended");
      reasons.push(r("dh/extended", "רק תחילת הדיבור המתחיל מודגשת; הוא נמשך עד סימן הפיסוק"));
    }
    if (window !== window0) {
      rules.push("dh/unit-label");
      reasons.push(r("dh/unit-label", `השורה מציינת סעיף (${ex.unit!.n}), והחיפוש הוגבל לשורה הממוספרת שלו בספר הבסיס`));
    }
    if (uniqueN) {
      rules.push("dh/unique-anchor");
      reasons.push(r("dh/unique-anchor", uniqueN === 1 ? "עוגן של מילה אחת נדירה, שמופיעה רק בשורה אחת בטווח" : `עוגן של ${uniqueN} המילים הראשונות, שמופיעות יחד רק בשורה אחת בטווח`));
    }
    const asWritten =
      kinds.size === 1 && kinds.has("exact") && win.run.tgtEnd <= win.lineTokens &&
      ex.dh.slice(win.run.srcStart, win.run.srcStart + win.run.srcUsed).every((t, k) => {
        const b = tg[win.run.tgtStart + k]!;
        return visibleSlice(cLine.text, t.rawStart, t.rawEnd) === visibleSlice(bLines[win.pos]!.text, b.rawStart, b.rawEnd);
      });
    if (asWritten) {
      rules.push("dh/exact");
      reasons.push(r("dh/exact", "הדיבור המתחיל נמצא כלשונו"));
    } else if (kinds.size === 1 && kinds.has("exact")) {
      rules.push("dh/normalized");
      reasons.push(r("dh/normalized", "נמצא אחרי נרמול ניקוד"));
    } else {
      if (kinds.has("fuzzy")) {
        rules.push("dh/fuzzy");
        reasons.push(r("dh/fuzzy", "נמצא בהתאמה גמישה (כתיב מלא או חסר, אותיות שימוש)"));
      }
      if (kinds.has("acronym") || kinds.has("truncation") || kinds.has("split")) {
        rules.push("dh/abbreviation");
        reasons.push(r("dh/abbreviation", "נמצא אחרי פתיחת ראשי תיבות או קיצור"));
      }
    }
    if (!uniqueN && win.run.srcUsed < ex.dh.length)
      reasons.push(r("dh/partial", `נמצאו ${win.run.srcUsed} מתוך ${ex.dh.length} מילות הדיבור המתחיל`));
    if (rung) {
      rules.push(`dh/rung-${rung}`);
      reasons.push(r(`dh/rung-${rung}`, RUNG_TEXT[rung]));
    }
    if (window.kind === "caller") reasons.push(r("dh/window-caller", "החיפוש הוגבל לטווח שנקבע לפי מבנה הספרים"));
    else if (window.kind === "heading") reasons.push(r("dh/window-heading", `החיפוש הוגבל לקטע "${window.label}" בספר הבסיס`));
    else if (window.kind === "unit") reasons.push(r("dh/window-unit", `החיפוש הוגבל לשורה הממוספרת שהכותרת בפירוש מציינת (${window.label})`));
    else if (window.kind === "page") reasons.push(r("dh/window-page", `החיפוש הוגבל לעמוד "${window.label}", לפי סימני העמודים שבספר הבסיס`));
    else reasons.push(r("dh/window-book", "החיפוש נעשה בכל ספר הבסיס, לפי סדר ההתקדמות של הפירוש"));
    if (prevIn !== null && win.line >= prevIn) {
      rules.push("dh/order");
      reasons.push(r("dh/order", "המקום הבא אחרי ההתאמה של השורה הקודמת"));
    } else if (prevIn !== null) warnings.push(r("dh/backward", `ההתאמה מוקדמת למקום של השורה הקודמת (שורה ${prevIn + 1} בספר הבסיס)`));
    if (confidence === "ambiguous" && alternatives[0])
      warnings.push(r("dh/ambiguous", `מקום אחר בספר הבסיס קרוב מאוד בציון: שורה ${alternatives[0].line + 1}`));

    let baseEnd: number | undefined;
    if (win.run.tgtEnd > win.lineTokens) {
      baseEnd = bLines[win.pos + 1]!.index;
      rules.push("dh/span-next-line");
      reasons.push(r("dh/span", "הדיבור המתחיל נמשך לשורה הבאה בספר הבסיס"));
    }
    if (win.contLine !== null) {
      rules.push("dh/continuation");
      reasons.push(r("dh/continuation", 'גם ההמשך שאחרי "וכו\'" נמצא בספר הבסיס'));
      if (win.contLine > (baseEnd ?? win.line)) baseEnd = win.contLine;
    }
    return {
      cLine: cLine.index,
      base: win.line,
      ...(baseEnd !== undefined ? { baseEnd } : {}),
      words: { rawStart: tg[win.run.tgtStart]!.rawStart, rawEnd: tg[firstLineEnd - 1]!.rawEnd },
      score,
      confidence,
      reasons,
      rules,
      warnings,
      alternatives,
      rootScore: score,
      depth: 0,
    };
  };

  /**
   * A numbered note placed on its marker. One marker of its number in the window → certain; several
   * (numbering that restarts, with no heading to tell the sections apart) → the first one at or after
   * the previous line's place, as high. Notes follow their markers in order: a marker before the
   * previous line's place (in the same window) is not this note's — the number is a paragraph number,
   * or the order is broken — and the line is left to the ד"ה search.
   */
  const placeOnMarker = (m: CommentatorMarkers, numbers: readonly number[], cLine: number, prev: number | null): Placement | null => {
    const window = windowFor(cLine);
    const prevIn = prev !== null && prev >= window.from && prev <= window.to ? prev : null;
    for (const n of numbers) {
      const at = markersIn(m, n, window);
      const base = prevIn === null ? at[0] : at.find((i) => i >= prevIn);
      if (base === undefined) continue;
      const score = at.length === 1 ? 0.97 : 0.9;
      const reasons = [r("dh/note-marker", `בשורת הבסיס יש סימן של הערה ${n} של "${m.commentator}", ולכן ההערה מקושרת לשם`)];
      const rules = ["dh/note-marker", `dh/window-${window.kind}`];
      if (at.length > 1) {
        rules.push("dh/note-marker-order");
        reasons.push(r("dh/note-marker-order", `בטווח יש ${at.length} סימנים של הערה ${n}; ${prevIn === null ? "נבחר הראשון שבהם" : "נבחר הראשון שאחרי המקום של השורה הקודמת"}`));
      }
      const alternatives = at.filter((i) => i !== base).slice(0, 3).map((line) => ({ line, score: 0.5 }));
      return { cLine, base, score, confidence: confidenceOf(score, alternatives[0]?.score ?? null, thresholds), reasons, rules, warnings: [], alternatives, rootScore: score, depth: 0 };
    }
    return null;
  };

  /** A line that continues `parent` (בא"ד, שם, עוד כתב, an item paragraph): its place, weakened. */
  const inherited = (cLine: number, parent: Placement, code: string, text: string, score: number): Placement => ({
    cLine,
    base: parent.base,
    ...(parent.baseEnd !== undefined ? { baseEnd: parent.baseEnd } : {}),
    score,
    confidence: confidenceOf(score, null, thresholds),
    reasons: [r(code, text)],
    rules: [code],
    warnings: [],
    alternatives: [],
    rootScore: parent.rootScore,
    depth: parent.depth + 1,
  });

  /** "ד"ה X … עד ד"ה Y": the line of Y, at or after X's place and inside X's window, else null. */
  const rangeEnd = (ex: ExtractedDh, cLine: number, start: number): number | null => {
    const window = windowFor(cLine);
    const sub: SearchWindow = { ...window, from: start, to: window.to };
    const end: ExtractedDh = { ...ex, dh: ex.range, continuation: [], explicit: true, range: [] };
    const cands = searchPass(end, sub, start, strict, new Map(), new Map());
    const best = cands[0];
    if (!best || best.line < start) return null;
    // the end must stand out: a rival as good elsewhere makes it a guess
    if (cands[1] && cands[1].rank >= best.rank * 0.95 && cands[1].line !== best.line) return null;
    return best.line;
  };

  // ── the walk over the commentary ─────────────────────────────────────────────────────────
  const placements: Placement[] = [];
  /** per placed commentary line: its section (between headings), the line it inherits from, and whether it was matched by its own words */
  const meta = new Map<number, { section: number; root: number; direct: boolean }>();
  let section = 0;
  const place = (pl: Placement, direct: boolean, root: number) => {
    placements.push(pl);
    meta.set(pl.cLine, { section, root: direct ? pl.cLine : (meta.get(root)?.root ?? root), direct });
  };
  const unmatched: { line: number; reasons: Reason[] }[] = [];
  let chain: Placement | null = null;
  let prev: number | null = null;
  let crossedHeading = false;
  let seenHeading = false;
  const hasHeadings = commentary.lines.some((l) => (l.heading ?? headingLevel(l.text) ?? 1) > 1);
  /** the strong bold ד"ה placement whose plain paragraphs follow (continueItems) */
  let itemHead: Placement | null = null;
  /** the intermediate commentator the lines are about (requirements §2), and the last one named */
  let active: Commentator | null = null;
  let lastNamed: Commentator | null = null;
  /**
   * The book labels whose words each line quotes (קרן אורה: "<b>שם גמרא</b>", "<b>תוס'</b> בד"ה" on most lines): then a
   * line with no label of its own stays with the commentator named last (requirements §2). In a book that
   * does not (most), only the lines that continue — בא"ד, שם, a bare ד"ה, an opener — do.
   */
  const labelingBook = (() => {
    let dh = 0;
    let labeled = 0;
    for (const e of cExtract.values()) if (e.kind === "dh") (dh++, e.addressee && labeled++);
    return dh > 0 && labeled * 2 >= dh;
  })();
  const skipFor = (who: Commentator | null, explicitText: boolean): Reason | null => {
    if (!routeIntermediates) return null;
    if (who && baseIs?.key !== who.key)
      return r("dh/intermediate", `השורה מפרשת את דברי ${who.name}, ולא את ספר הבסיס; היא שייכת לשורה של ${who.name}`);
    if (!who && explicitText && baseIs)
      return r("dh/not-intermediate", `השורה מפרשת את הטקסט עצמו (גמרא/משנה), ולא את ${baseIs.name} שהוא ספר הבסיס`);
    if (addressedOnly && baseIs && !who)
      return r("dh/not-addressed", `השורה אינה מזכירה את ${baseIs.name}, ולכן היא מפרשת את הטקסט ולא את דבריו`);
    return null;
  };
  const total = commentary.lines.length;
  let done = 0;
  let aborted = false;
  for (const line of commentary.lines) {
    if (done % 25 === 0) ctx.progress?.(done, total);
    if (ctx.signal?.aborted) {
      aborted = true;
      break;
    }
    done++;
    const ex = cExtract.get(line.index)!;
    if (ex.kind === "heading") {
      crossedHeading = true;
      section++;
      if (line.heading !== 1 && headingLevel(line.text) !== 1) seenHeading = true;
      // a heading is a hard reset (requirements §8): nothing below it inherits from above it
      active = null;
      itemHead = null;
      continue;
    }
    // whose words this line quotes (requirements §2)
    if (ex.addressee?.kind === "named") active = lastNamed = ex.addressee.commentator;
    else if (ex.addressee?.kind === "text") active = null;
    else if (ex.addressee?.kind === "bare") active ??= lastNamed;
    // a new ד"ה that names nobody, in a book that does not label its lines, quotes the base text
    else if (ex.kind === "dh" && !labelingBook) active = null;
    // front matter and colophons are not commentary (requirements §9)
    if (ex.kind === "dh" && !seenHeading && hasHeadings && !ex.explicit && ex.tokens.length <= 12) {
      unmatched.push({ line: line.index, reasons: [r("dh/front-matter", "שורה שלפני הכותרת הראשונה (שם המחבר, פתיחה), ולא דיבור המתחיל")] });
      continue;
    }
    if (COLOPHON_RE.test(line.text)) {
      unmatched.push({ line: line.index, reasons: [r("dh/colophon", "סיום הספר או החלק (סליק, תם ונשלם), ולא דיבור המתחיל")] });
      continue;
    }
    const skip = skipFor(active, ex.addressee?.kind === "text");
    if (skip) {
      unmatched.push({ line: line.index, reasons: [skip] });
      chain = null;
      itemHead = null;
      continue;
    }
    if (unaddressed && !active) unaddressed.add(line.index);
    const marked: Placement | null = noteMarkers && noteNumbers.has(line.index) ? placeOnMarker(noteMarkers, noteNumbers.get(line.index)!, line.index, prev) : null;
    if (marked) {
      crossedHeading = false;
      place(marked, false, marked.cLine);
      chain = marked;
      prev = marked.base;
      continue;
    }
    if (ex.kind === "empty") {
      if (ex.tokens.length) {
        unmatched.push({ line: line.index, reasons: [r("dh/no-dh", "בשורה אין דיבור המתחיל לחפש (רק מילות הפניה)")] });
        chain = null;
      }
      continue;
    }
    if (ex.kind === "baad" || ex.kind === "sham" || ex.kind === "continuation") {
      // never across a heading (requirements §8)
      const allowed = inherit && chain && !crossedHeading;
      crossedHeading = false;
      if (!allowed || !chain) {
        const what = ex.kind === "baad" ? 'שורת "בא"ד"' : ex.kind === "sham" ? 'שורת "שם"' : `שורת המשך ("${ex.stripped.join(" ")}")`;
        unmatched.push({ line: line.index, reasons: [r("dh/no-parent", `${what} בלי שורה קודמת שקושרה באותו קטע`)] });
        chain = null;
        continue;
      }
      const code = ex.kind === "baad" ? "dh/inherit-baad" : ex.kind === "sham" ? "dh/inherit-sham" : "dh/inherit-opener";
      const text =
        ex.kind === "baad"
          ? 'השורה פותחת ב"בא"ד", ולכן היא מקושרת לאותו מקום כמו השורה הקודמת'
          : ex.kind === "sham"
            ? 'השורה היא "שם", ולכן היא מקושרת לאותו מקום כמו השורה הקודמת'
            : `השורה פותחת ב"${ex.stripped.join(" ")}", המשך של השורה הקודמת, ולכן היא מקושרת לאותו מקום`;
      const p = inherited(line.index, chain, code, text, inheritedConfidence(chain.rootScore, chain.depth + 1));
      if (p.confidence === "none") {
        unmatched.push({ line: line.index, reasons: [r("dh/inherit-weak", "השרשרת של שורות ההמשך ארוכה מדי, והביטחון בקישור נמוך מדי")] });
        chain = null;
        continue;
      }
      place(p, false, chain.cLine);
      chain = p;
      continue;
    }
    const crossed = crossedHeading;
    crossedHeading = false;
    let placed = placeDh(ex, line, prev);
    if (!Array.isArray(placed) && placed.confidence === "none")
      placed = [r("dh/weak", `נמצאה התאמה חלשה מדי בשורה ${placed.base + 1} בספר הבסיס`), ...placed.reasons];
    if (Array.isArray(placed)) {
      // a plain paragraph of the item above it (continueItems)
      if (continueItems && itemBook && !ex.bold && itemHead && !crossed) {
        const score = Math.min(0.93, itemHead.rootScore * 0.97);
        const p = inherited(line.index, itemHead, "dh/inherit-item", "פסקה בלי דיבור המתחיל משלה, אחרי הדיבור המתחיל של הקטע: היא שייכת לאותו מקום", score);
        place(p, false, itemHead.cLine);
        chain = p;
        continue;
      }
      unmatched.push({ line: line.index, reasons: placed });
      chain = null;
      if (ex.bold) itemHead = null;
      continue;
    }
    if (ex.range.length) {
      const end = rangeEnd(ex, line.index, placed.baseEnd ?? placed.base);
      if (end !== null && end > (placed.baseEnd ?? placed.base))
        placed = { ...placed, baseEnd: end, rules: [...placed.rules, "dh/range"], reasons: [...placed.reasons, r("dh/range", `הפירוש מציין טווח ("עד ד"ה"), וסוף הטווח נמצא בשורה ${end + 1} בספר הבסיס`)] };
      else placed = { ...placed, warnings: [...placed.warnings, r("dh/range-unresolved", 'הפירוש מציין טווח ("עד ד"ה"), אבל סוף הטווח לא נמצא בוודאות; הקישור הוא לתחילת הטווח בלבד')] };
    }
    place(placed, true, placed.cLine);
    chain = placed;
    prev = placed.base;
    itemHead = ex.bold && (placed.confidence === "certain" || placed.confidence === "high") ? placed : null;
  }
  ctx.progress?.(done, total);
  if (aborted) notes.push(r("engine/aborted", "הריצה הופסקה לפני הסוף. מוצגות רק ההצעות שנמצאו עד כה."));

  /*
   * ── the order of the whole commentary ─────────────────────────────────────────────────────
   * A commentary follows its base, so the lines it places by their own words lie on one non-decreasing
   * chain of base lines — except the wrong ones. Two chains: over the whole book, and inside each
   * section of the commentary (a section ordered differently from the base keeps its own order).
   * Measured on the 51 pairs (REAL_DATA_REPORT.md §7.2): a placement off BOTH chains was right in 64 of
   * 497 (certain 7/20, high 37/136, possible 9/115, ambiguous 11/226) — it is dropped; one off the
   * book's chain but on its section's was right in 73 of 170 — "possible"/"ambiguous" ones (21/97) are
   * dropped, "high" (45/65) becomes "ambiguous" and "certain" (7/8) "high". On the chains: certain
   * 99.0%, high 98.2%, possible 94.9%, ambiguous 77.4%. A line that inherits a dropped line's place
   * (בא"ד, שם, an item paragraph) goes with it.
   */
  if (options.order !== false) {
    const direct = placements.filter((pl) => meta.get(pl.cLine)?.direct);
    const onBook = monotoneChain(direct);
    const bySection = new Map<number, Placement[]>();
    for (const pl of direct) {
      const sec = meta.get(pl.cLine)!.section;
      const list = bySection.get(sec);
      if (list) list.push(pl);
      else bySection.set(sec, [pl]);
    }
    const onSection = new Set<number>();
    for (const list of bySection.values()) for (const c of monotoneChain(list)) onSection.add(c);
    const dropped = new Set<number>();
    const offText = (pl: Placement) => `ההתאמה (שורה ${pl.base + 1} בספר הבסיס) אינה בסדר של שאר הפירוש: השורות שלפניה ואחריה קושרו למקומות שאינם מתיישבים איתה`;
    for (let i = 0; i < placements.length; i++) {
      const pl = placements[i]!;
      if (!meta.get(pl.cLine)?.direct || onBook.has(pl.cLine)) continue;
      const weak = pl.confidence === "possible" || pl.confidence === "ambiguous";
      if (!onSection.has(pl.cLine) || weak) {
        dropped.add(pl.cLine);
        unmatched.push({ line: pl.cLine, reasons: [r("dh/off-order", `${offText(pl)}; התאמה כזו שגויה ברוב המקרים, ולכן לא הוצעה`)] });
        continue;
      }
      const confidence = pl.confidence === "certain" ? "high" : "ambiguous";
      placements[i] = { ...pl, confidence, score: Math.min(pl.score, thresholds.certain - 0.01), rules: [...pl.rules, "dh/off-order"], warnings: [...pl.warnings, r("dh/off-order", `${offText(pl)} בספר כולו, אף שהיא בסדר בתוך הקטע שלה; הוודאות הורדה`)] };
    }
    if (dropped.size) {
      for (const pl of placements)
        if (!dropped.has(pl.cLine) && dropped.has(meta.get(pl.cLine)!.root)) {
          dropped.add(pl.cLine);
          unmatched.push({ line: pl.cLine, reasons: [r("dh/off-order-parent", "השורה יורשת את המקום של שורה קודמת שההתאמה שלה בוטלה, כי אינה בסדר של הפירוש")] });
        }
      for (let i = placements.length - 1; i >= 0; i--) if (dropped.has(placements[i]!.cLine)) placements.splice(i, 1);
      unmatched.sort((a, b) => a.line - b.line);
    }
  }

  // ── shape the suggestions ────────────────────────────────────────────────────────────────
  const cByIndex = new Map(commentary.lines.map((l) => [l.index, l]));
  const side = (book: BookRef, line: number, end?: number): LinkSide => (end !== undefined && end > line ? { book, line, end } : { book, line });
  const suggestions: Suggestion[] = placements.map((p) => {
    const baseSide = side(base.book, p.base, p.baseEnd);
    const cSide = side(commentary.book, p.cLine);
    const baseLine = bLines[posOf.get(p.base)!];
    const warnings = [...p.warnings];
    const rules = [...p.rules];
    const reasons = [...p.reasons];
    let confidence = p.confidence;
    if (unaddressed?.has(p.cLine) && (confidence === "certain" || confidence === "high")) {
      confidence = "possible";
      rules.push("dh/not-addressed-cap");
      warnings.push(r("dh/not-addressed-cap", `השורה אינה מזכירה את ${baseIs!.name}, ולכן לא ברור שהיא מפרשת את דבריו ולא את הטקסט; לבדיקה.`));
    }
    let anchor: RawAnchor | undefined;
    if (policy.anchors && p.words) {
      if (baseLine && NOTE_RE.test(baseLine.text))
        warnings.push(r("dh/anchor-skipped-notes", "בשורת הבסיס יש הערות ממוזגות. עוגן עליה היה מבטל את מיזוג ההערות בספרייה, ולכן לא נוסף עוגן."));
      else {
        anchor = { rawStart: p.words.rawStart, rawEnd: p.words.rawEnd };
        rules.push("dh/anchor-base");
        reasons.push(r("dh/anchor-base", "העוגן מסמן את מילות הדיבור המתחיל בשורת ספר הבסיס"));
      }
    }
    const altSide = (line: number): LinkSide => ({ book: base.book, line });
    const alternatives: Candidate[] = p.alternatives.map((a) => ({
      target: altSide(a.line),
      score: a.score,
      reasons: [r("dh/alternative", `מקום נוסף שבו נמצא הדיבור המתחיל: שורה ${a.line + 1} בספר הבסיס`)],
    }));
    const common = {
      id: `dibur-hamatchil:${commentary.book.key}#${p.cLine}>${base.book.key}#${p.base}`,
      engine: "dibur-hamatchil" as const,
      score: p.score,
      confidence,
      reasons,
      rules,
      alternatives,
      warnings,
    };
    return policy.anchors
      ? { ...common, source: baseSide, ...(anchor ? { anchor } : {}), target: cSide, declaredType: types.anchored, heRef2: heRefOf(commentary, cPath, cByIndex.get(p.cLine), p.cLine) }
      : { ...common, source: cSide, target: baseSide, declaredType: types.plain, heRef2: heRefOf(base, bPath, baseLine, p.base) };
  });

  return { suggestions, notes, unmatched };
}
