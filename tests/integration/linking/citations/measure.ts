import type { Link } from "../../../../src/core/links/model";
import type { Confidence, Suggestion } from "../../../../src/linking/automatic";

/*
 * Scoring the citations engine against the links a database already has from the same book.
 *
 * Ground truth = the database's citation-like links touching the source book: LINKER (LinkerToOtzaria,
 * one direction, source = the citing line) and REFERENCE / QUOTATION (either direction). A suggestion
 * is judged on (source line, target book):
 *   • correct   — the database links that line to that book, and the two targets intersect (a line
 *                 inside our range, or our line inside the stored range); `exact` when the first
 *                 lines are equal;
 *   • wrong     — the database links that line to that book, but somewhere else;
 *   • unconfirmed — the database has no link from that line to that book (a LINKER miss, or our
 *                 error: sampled by hand, see docs/AUTOMATION_ENGINE.md §5).
 * Recall counts LINKER links only (REFERENCE/QUOTATION are not all explicit citations).
 */

export interface GoldLink {
  line: number;
  bookKey: string;
  bookTitle: string;
  from: number;
  to: number;
  type: string;
  link: Link;
}

const GOLD_TYPES = new Set(["linker", "reference", "quotation"]);

export function goldOf(links: readonly Link[], sourceKey: string): GoldLink[] {
  const out: GoldLink[] = [];
  for (const l of links) {
    if (!GOLD_TYPES.has(l.declaredType)) continue;
    const [mine, other] = l.source.book.key === sourceKey ? [l.source, l.target] : l.target.book.key === sourceKey ? [l.target, l.source] : [null, null];
    if (!mine || !other || other.book.key === sourceKey) continue;
    out.push({ line: mine.line, bookKey: other.book.key, bookTitle: other.book.title, from: other.line, to: other.end ?? other.line, type: l.declaredType, link: l });
  }
  return out;
}

export type Verdict = "correct" | "wrong" | "unconfirmed";

export interface Judged {
  s: Suggestion;
  verdict: Verdict;
  exact: boolean;
}

export function judge(suggestions: readonly Suggestion[], gold: readonly GoldLink[]): { judged: Judged[]; found: Set<GoldLink>; linkerTotal: number } {
  const byLine = new Map<string, GoldLink[]>();
  for (const g of gold) {
    const k = `${g.line}|${g.bookKey}`;
    byLine.set(k, [...(byLine.get(k) ?? []), g]);
  }
  const found = new Set<GoldLink>();
  const judged: Judged[] = [];
  for (const s of suggestions) {
    const list = byLine.get(`${s.source.line}|${s.target.book.key}`) ?? [];
    const from = s.target.line;
    const to = s.target.end ?? s.target.line;
    const hits = list.filter((g) => g.from <= to && from <= g.to);
    for (const h of hits) found.add(h);
    judged.push({ s, verdict: hits.length ? "correct" : list.length ? "wrong" : "unconfirmed", exact: hits.some((h) => h.from === from) });
  }
  return { judged, found, linkerTotal: gold.filter((g) => g.type === "linker").length };
}

export interface Tally {
  n: number;
  correct: number;
  wrong: number;
  unconfirmed: number;
  exact: number;
}

export const emptyTally = (): Tally => ({ n: 0, correct: 0, wrong: 0, unconfirmed: 0, exact: 0 });

export function add(t: Tally, j: Judged): void {
  t.n++;
  t[j.verdict]++;
  if (j.exact) t.exact++;
}

/** correct / all (strict: an unconfirmed suggestion counts as wrong) and correct / judged */
export const precision = (t: Tally): { strict: number; judged: number } => ({
  strict: t.n ? t.correct / t.n : 1,
  judged: t.correct + t.wrong ? t.correct / (t.correct + t.wrong) : 1,
});

export const LEVELS: readonly Confidence[] = ["certain", "high", "possible", "ambiguous"];

export const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
