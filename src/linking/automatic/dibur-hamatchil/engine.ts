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
import { headingWindows, widen, type SearchWindow } from "./windows";

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
  /** בא"ד / שם lines take the previous line's place (default true) */
  readonly inherit?: boolean;
}

const r = (code: string, text: string): Reason => ({ code, text });

const BOUNDARY_REASON: Readonly<Record<string, Reason>> = {
  bold: r("dh/boundary-bold", "הדיבור המתחיל מודגש בשורת הפירוש"),
  etc: r("dh/boundary-etc", 'הדיבור המתחיל מסתיים ב"וכו\'"'),
  punctuation: r("dh/boundary-punctuation", "הדיבור המתחיל מסתיים בנקודה או בנקודתיים"),
  dash: r("dh/boundary-dash", "הדיבור המתחיל מסתיים במקף"),
  none: r("dh/boundary-none", "בשורה אין סימן לסוף הדיבור המתחיל, ולכן נבדקו המילים הראשונות שלה"),
};
const RUNG_TEXT: Readonly<Record<Rung, string>> = {
  A: "נמצא רק אחרי הקלה בחיפוש (שלב א: גם באמצע שורת הבסיס)",
  B: "נמצא רק אחרי הקלה בחיפוש (שלב ב: בלי משקל לפי נדירות המילים)",
  C: "נמצא רק אחרי הקלה בחיפוש (שלב ג: גם בקטעים הסמוכים)",
  D: "נמצא רק אחרי הקלה בחיפוש (שלב ד: בסף התאמה נמוך)",
};

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
}

/** Which record shape can carry an anchor on the base words (see DH_ANCHOR_DIRECTION.md). */
export function anchorPolicy(commentary: BookRef, base: BookRef, mode: "auto" | "off" = "auto"): { anchors: boolean; reason: Reason } {
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
  const f = storedForm({ source: { book: base, line: 0 }, target: { book: commentary, line: 0 }, declaredType: "commentary" });
  if (f.flipped || f.downgraded || f.skipped)
    return { anchors: false, reason: r("dh/anchors-flip", "במבנה הזה אוצריא הייתה הופכת את כיוון הקישור, והעוגן היה נזרק. הקישורים נכתבים מצד הפירוש ובלי עוגן.") };
  return {
    anchors: true,
    reason: r("dh/anchors-base", "הקישורים נכתבים מצד ספר הבסיס (כקישור פירוש), עם עוגן על מילות הדיבור המתחיל. הם שייכים לקובץ הקישורים של ספר הבסיס."),
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
  const inherit = options.inherit !== false;
  const policy = anchorPolicy(commentary.book, base.book, options.anchors ?? "auto");
  const notes: Reason[] = [policy.reason];

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
  const defaultWindows = headingWindows(commentary, base);
  const first = bLines[0]?.index ?? 0;
  const last = bLines.at(-1)?.index ?? 0;
  const windowFor = (cLine: number): SearchWindow => {
    const w = options.windows?.(cLine);
    if (w) return { from: Math.max(first, Math.min(w.from, w.to)), to: Math.min(last, Math.max(w.from, w.to)), kind: "caller" };
    return defaultWindows(cLine);
  };
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
        const rank = ((exact ? 10 : 0) + matchedWeight) * orderFactor(line.index, prev);
        found.set(p, { pos: p, line: line.index, run, exact, matchedWeight, windowWeight: ww, rank, lineTokens: tg.length, contLine });
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
        cand: { pos: hit, line: bLines[hit]!.index, run, exact: n > 1, matchedWeight: anchorWeight, windowWeight, rank: anchorWeight, lineTokens: bTokens[hit]!.length, contLine: null },
      };
    }
    return null;
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
  const placeDh = (ex: ExtractedDh, cLine: EngineLine, prev: number | null): Placement | Reason[] => {
    const window = windowFor(cLine.index);
    const prevIn = prev !== null && prev >= window.from && prev <= window.to ? prev : null;
    let rung: Rung | null = null;
    const runs: RunCache = new Map();
    const startsCache = new Map<string, Map<number, number[]>[]>();
    let cands = searchPass(ex, window, prevIn, strict, runs, startsCache);
    if (!cands.length && ex.explicit && useLadder) {
      const A: SearchSpec = { ...strict, requireTargetStart: false, deepMinRun: 2 };
      const B: SearchSpec = { ...A, useIdf: false };
      const D: SearchSpec = { ...B, multiplier: 0.4 };
      const wide = widen(window, base);
      for (const [rg, spec, win] of [["A", A, window], ["B", B, window], ["C", B, wide], ["D", D, wide]] as const) {
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
    if (!cands.length)
      return [r("dh/not-found", `הדיבור המתחיל "${ex.text}" לא נמצא בטווח החיפוש (שורות ${window.from + 1}–${window.to + 1} בספר הבסיס)`)];

    const win = cands[0]!;
    const rivals = cands.slice(1, 4);
    const score = matchConfidence({ evidence: evidenceOf(win, rivals[0]?.rank ?? 0), explicit: ex.explicit, rung });
    // every rival is scored on its own measured evidence, against the winner as ITS rival — two
    // verbatim occurrences then score alike and the result is reported as ambiguous (the source
    // kept the verbatim flag for the winner only, which hid exactly these ties)
    const alternatives = rivals.map((c) => ({ line: c.line, score: matchConfidence({ evidence: evidenceOf(c, win.rank), explicit: ex.explicit, rung }) }));
    alternatives.sort((a, b) => b.score - a.score);
    const confidence = confidenceOf(score, alternatives[0]?.score ?? null, thresholds);

    const reasons: Reason[] = [BOUNDARY_REASON[ex.boundary]!];
    const rules = [`dh/extract-${ex.boundary}`, `dh/window-${window.kind}`];
    const warnings: Reason[] = [];
    const kinds = win.run.kinds;
    const firstLineEnd = Math.min(win.run.tgtEnd, win.lineTokens);
    const tg = bTokens[win.pos]!;
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

  // ── the walk over the commentary ─────────────────────────────────────────────────────────
  const placements: Placement[] = [];
  const unmatched: { line: number; reasons: Reason[] }[] = [];
  let chain: Placement | null = null;
  let prev: number | null = null;
  let crossedHeading = false;
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
      continue;
    }
    if (ex.kind === "empty") {
      if (ex.tokens.length) {
        unmatched.push({ line: line.index, reasons: [r("dh/no-dh", "בשורה אין דיבור המתחיל לחפש (רק מילות הפניה)")] });
        chain = null;
      }
      continue;
    }
    if (ex.kind === "baad" || ex.kind === "sham") {
      const allowed = inherit && chain && !(ex.kind === "sham" && crossedHeading);
      crossedHeading = false;
      if (!allowed || !chain) {
        unmatched.push({ line: line.index, reasons: [r("dh/no-parent", ex.kind === "baad" ? 'שורת "בא"ד" בלי שורה קודמת שקושרה' : 'שורת "שם" בלי שורה קודמת שקושרה')] });
        chain = null;
        continue;
      }
      const depth = chain.depth + 1;
      const score = inheritedConfidence(chain.rootScore, depth);
      const code = ex.kind === "baad" ? "dh/inherit-baad" : "dh/inherit-sham";
      const p: Placement = {
        cLine: line.index,
        base: chain.base,
        score,
        confidence: confidenceOf(score, null, thresholds),
        reasons: [
          r(code, ex.kind === "baad" ? 'השורה פותחת ב"בא"ד", ולכן היא מקושרת לאותו מקום כמו השורה הקודמת' : 'השורה היא "שם", ולכן היא מקושרת לאותו מקום כמו השורה הקודמת'),
        ],
        rules: [code],
        warnings: [],
        alternatives: [],
        rootScore: chain.rootScore,
        depth,
      };
      if (p.confidence === "none") {
        unmatched.push({ line: line.index, reasons: [r("dh/inherit-weak", "השרשרת של שורות ההמשך ארוכה מדי, והביטחון בקישור נמוך מדי")] });
        chain = null;
        continue;
      }
      placements.push(p);
      chain = p;
      continue;
    }
    crossedHeading = false;
    const placed = placeDh(ex, line, prev);
    if (Array.isArray(placed)) {
      unmatched.push({ line: line.index, reasons: placed });
      chain = null;
      continue;
    }
    if (placed.confidence === "none") {
      unmatched.push({ line: line.index, reasons: [r("dh/weak", `נמצאה התאמה חלשה מדי בשורה ${placed.base + 1} בספר הבסיס`), ...placed.reasons] });
      chain = null;
      continue;
    }
    placements.push(placed);
    chain = placed;
    prev = placed.base;
  }
  ctx.progress?.(done, total);
  if (aborted) notes.push(r("engine/aborted", "הריצה הופסקה לפני הסוף. מוצגות רק ההצעות שנמצאו עד כה."));

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
      confidence: p.confidence,
      reasons,
      rules,
      alternatives,
      warnings,
    };
    return policy.anchors
      ? { ...common, source: baseSide, ...(anchor ? { anchor } : {}), target: cSide, declaredType: "commentary", heRef2: heRefOf(commentary, cPath, cByIndex.get(p.cLine), p.cLine) }
      : { ...common, source: cSide, target: baseSide, declaredType: "source", heRef2: heRefOf(base, bPath, baseLine, p.base) };
  });

  return { suggestions, notes, unmatched };
}
