/*
 * Breaking a tie between places of one ד"ה (the "ambiguous" tier). The search scores a place by the
 * ד"ה's own words, so when the same words stand in two or more base lines of the window the scores
 * tie, and the only tie-break was "the first one after the previous line's place". Two more signals,
 * both general (no book names, no patterns of one book):
 *
 *   • context — the commentary line's OWN words after its ד"ה, weighted by rarity, that also stand in
 *     the candidate base line. A lexicon entry ("אמן ב' אין עונין אמן יתומה") or a commentary that
 *     goes on quoting the passage ("חבילי קש … פעמים שאדם בא מן השדה") names the right line in its body;
 *   • order — a place between the places of the nearest strong lines before and after it
 *     (certain/high), since a commentary follows its base. The walk knows only the lines before; this
 *     also looks at the NEXT strong line, and keeps a context pick from jumping past it.
 *
 * A tie-break only chooses among places whose calibrated scores are within the ambiguity margin of
 * each other: it never adds or drops a suggestion and never raises its tier (engine.ts keeps it
 * "ambiguous"). Measured on the real database: docs/AUTOMATION_ENGINE.md §3.2.
 */
import { skeleton, stem } from "../../../core/text/hebrew";
import type { HebToken } from "../../../matching/hebrew-tokens";
import { STOP_WORDS } from "../../../matching/word-weights";

/** at most this many words after the ד"ה are read as its context */
export const CONTEXT_WORDS = 60;
/** a rival replaces the current pick only with this much more context weight than any other place (more than one rare word; tuned on the development sample, AUTOMATION_ENGINE.md §3.2) */
export const CONTEXT_GAIN = 1.5;

/** One context word: its search key, its looser form (stem skeleton, "~…"; null when too short to trust) and weight. */
export interface ContextWord {
  readonly key: string;
  readonly loose: string | null;
  readonly weight: number;
}

/** The loose form of a key, as the inverted index of the engine spells it ("~" + stem skeleton); null under 3 letters. */
export function looseKey(key: string): string | null {
  const s = skeleton(stem(key));
  return s.length >= 3 ? `~${s}` : null;
}

/**
 * The content words of a commentary line after its ד"ה (`after` = token index just past the ד"ה):
 * distinct, not stop words, at least 3 letters (or an acronym), and not words of the ד"ה itself —
 * those stand in every candidate alike and tell nothing.
 */
export function contextWords(tokens: readonly HebToken[], after: number, dh: readonly HebToken[], weight: (key: string) => number, max = CONTEXT_WORDS): ContextWord[] {
  const own = new Set(dh.map((t) => t.key));
  const seen = new Set<string>();
  const out: ContextWord[] = [];
  for (const t of tokens.slice(after, after + max)) {
    if (own.has(t.key) || seen.has(t.key) || STOP_WORDS.has(t.key)) continue;
    if (t.key.length < 3 && !t.acronym) continue;
    seen.add(t.key);
    out.push({ key: t.key, loose: t.key.length >= 4 ? looseKey(t.key) : null, weight: weight(t.key) });
  }
  return out;
}

/** The keys of a base line (search keys and their loose forms) that context words are looked up in. */
export function lineKeys(tokens: readonly HebToken[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    out.add(t.key);
    if (t.key.length >= 4) {
      const l = looseKey(t.key);
      if (l) out.add(l);
    }
  }
  return out;
}

/** Weight of the context words that stand in the line (by key, or by loose form). */
export function contextScore(keys: ReadonlySet<string>, ctx: readonly ContextWord[]): number {
  let s = 0;
  for (const w of ctx) if (keys.has(w.key) || (w.loose !== null && keys.has(w.loose))) s += w.weight;
  return Math.round(s * 1000) / 1000;
}

/** A tied place, as the tie-break sees it. */
export interface TieCandidate {
  readonly line: number;
  /** calibrated score of the place (matchConfidence) */
  readonly score: number;
  /** contextScore of its base line */
  readonly context: number;
}

/**
 * The tied place the context names (index into `cands`; 0 = keep the current pick). A rival wins only
 * with `gain` more context weight than the current pick and than every other rival, at or after the
 * previous line's place (`prev`; a weak place before it is never suggested, engine.ts dh/backward-weak),
 * and with a score that is still a suggestion (`floor`).
 */
export function pickByContext(cands: readonly TieCandidate[], prev: number | null, floor: number, gain = CONTEXT_GAIN): number {
  let best = 0;
  for (let k = 1; k < cands.length; k++) {
    const c = cands[k]!;
    if (c.score < floor || (prev !== null && c.line < prev)) continue;
    if (c.context > cands[best]!.context) best = k;
  }
  if (best === 0) return 0;
  const runnerUp = Math.max(...cands.filter((_, k) => k !== best).map((c) => c.context));
  return cands[best]!.context - runnerUp >= gain ? best : 0;
}

/**
 * The tied place that fits between the nearest strongly placed lines before (`lo`) and after (`hi`)
 * this one (index into `cands`; `current` = keep). Kept when the current pick fits, or when no rival
 * does; among several that fit: the most context, then the best score, then the earliest line.
 */
export function pickByOrder(cands: readonly TieCandidate[], current: number, lo: number | null, hi: number | null, floor: number): number {
  const fits = (line: number) => (lo === null || line >= lo) && (hi === null || line <= hi);
  if (fits(cands[current]!.line)) return current;
  let best = current;
  for (let k = 0; k < cands.length; k++) {
    const c = cands[k]!;
    if (k === current || c.score < floor || !fits(c.line)) continue;
    const b = cands[best]!;
    if (best === current || c.context > b.context || (c.context === b.context && (c.score > b.score || (c.score === b.score && c.line < b.line)))) best = k;
  }
  return best;
}
