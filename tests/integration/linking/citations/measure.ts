import type { Link } from "../../../../src/core/links/model";
import { countVisibleChars } from "../../../../src/core/text/offsets";
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
 *                 error: sampled by hand, see docs/AUTOMATION_ENGINE.md §6).
 * Recall counts LINKER links only (REFERENCE/QUOTATION are not all explicit citations).
 *
 * A LINKER link from the book to ITSELF ("לעיל סי' ה" — LinkerToOtzaria made a few thousand) is gold of its
 * own type, "linker-self": it judges the internal references (self.ts) and is counted apart, so the recall
 * against the other books stays comparable with earlier measurements.
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
    // LINKER is one-way (source = the citing line): a LINKER link INTO this book is another book's citation
    if (l.declaredType === "linker" && l.source.book.key === sourceKey && l.target.book.key === sourceKey) {
      out.push({ line: l.source.line, bookKey: sourceKey, bookTitle: l.target.book.title, from: l.target.line, to: l.target.end ?? l.target.line, type: "linker-self", link: l });
      continue;
    }
    const [mine, other] = l.source.book.key === sourceKey ? [l.source, l.target] : l.target.book.key === sourceKey && l.declaredType !== "linker" ? [l.target, l.source] : [null, null];
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

/**
 * `lineText` (the source line's anchor text) makes the judge span-aware: a suggestion is WRONG only
 * when a LINKER citation of the same words (overlapping anchor) points elsewhere in that book; when
 * the database links that line to that book only from other words, or only by REFERENCE/QUOTATION
 * (no span), the suggestion is a mention it did not link — unconfirmed. Without `lineText` any
 * disagreement on the line counts as wrong.
 */
export function judge(suggestions: readonly Suggestion[], gold: readonly GoldLink[], lineText?: (line: number) => string | undefined): { judged: Judged[]; found: Set<GoldLink>; linkerTotal: number; selfTotal: number } {
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
    // a unit narrowed to its first line (citedSpan) still names the whole unit: a stored link inside it agrees
    const to = s.citedSpan?.end ?? s.target.end ?? s.target.line;
    const hits = list.filter((g) => g.from <= to && from <= g.to);
    for (const h of hits) found.add(h);
    let verdict: Verdict = hits.length ? "correct" : list.length ? "wrong" : "unconfirmed";
    const span = /@(\d+)-(\d+)>/.exec(s.id);
    const text = lineText?.(s.source.line);
    if (verdict === "wrong" && span && text !== undefined) {
      const a = countVisibleChars(text, Number(span[1]));
      const b = countVisibleChars(text, Number(span[2]));
      // only a LINKER citation on the SAME words can contradict us; a REFERENCE/QUOTATION link (no
      // span: Sefaria's quotations, or another book citing this line) or a LINKER citation of other
      // words in the line says nothing about this mention
      const sameWords = list.some((g) => {
        if (g.type !== "linker" && g.type !== "linker-self") return false;
        const x = g.link.dbAnchors?.find((y) => y.side === 0);
        return !x || (x.charStart < b && a < (x.charEnd ?? x.charStart + 1));
      });
      if (!sameWords) verdict = "unconfirmed";
    }
    judged.push({ s, verdict, exact: hits.some((h) => h.from === from) });
  }
  return { judged, found, linkerTotal: gold.filter((g) => g.type === "linker").length, selfTotal: gold.filter((g) => g.type === "linker-self").length };
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
