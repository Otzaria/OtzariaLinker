import { createHash } from "node:crypto";
import type { Link, LinkSide } from "../../src/core/links/model";
import { pushTo } from "../../src/core/collections";
import { countVisibleChars } from "../../src/core/text/offsets";
import type { Confidence, EngineId, Suggestion } from "../../src/linking/automatic/types";

/*
 * The library benchmark (docs/validation/LIBRARY_BENCHMARK.md): pure helpers of
 * library-benchmark.test.ts — who "owns" a database link, the stratified sample, the scoring of one
 * book's max-link output against every link the database has at that book, and the estimates.
 *
 * Ownership decides which run must regenerate a link, so that no link is counted twice:
 *   - LINKER is one-way (source = the citing line): its source book owns it ("D:<id>");
 *   - a link between a dependant and the base the max-link planner relates it to (book_base_text,
 *     "X על Y", "הערות על Y") is owned by the dependant: its pair steps are the ones that link it;
 *   - every other link (Sefaria's undirected layers: OTHER, RELATED, MESORAT_HASHAS, EIN_MISHPAT…) is
 *     owned by the PAIR ("U:<a>-<b>", a ≤ b): the citations engine may find it from either end, so it
 *     counts as regenerated when the run of either book finds it.
 */

export type Owner = string;

export function ownerOf(type: string, s: number, t: number, related: (dep: number, base: number) => boolean): Owner {
  if (type === "LINKER") return `D:${s}`;
  if (related(s, t)) return `D:${s}`;
  if (related(t, s)) return `D:${t}`;
  return s <= t ? `U:${s}-${t}` : `U:${t}-${s}`;
}

/** The books whose runs can regenerate an owner's links. */
export const ownerBooks = (o: Owner): number[] => o.slice(2).split("-").map(Number);

// ─── deterministic order and sampling ───────────────────────────────────────────────────────────

/** A stable pseudo-random rank of a unit for a seed (sha1, first 8 hex digits). */
export const rankOf = (seed: string, unit: string): number => parseInt(createHash("sha1").update(`${seed}|${unit}`).digest("hex").slice(0, 8), 16);

export interface Unit {
  /** the owner key */
  id: Owner;
  stratum: string;
  /** links of the type the unit owns (the stratum weight) */
  links: number;
}

export interface Stratum {
  name: string;
  units: Unit[];
  links: number;
}

/**
 * Strata whose links are under `minShare` of the type are pooled into one, so that every stratum the
 * estimate uses is sampled. Units in a stratum are ordered by rankOf(seed, id): a larger sample is a
 * superset of a smaller one (runs are resumable and can be extended).
 */
export function stratify(units: readonly Unit[], seed: string, minShare = 0.01): Stratum[] {
  const total = units.reduce((n, u) => n + u.links, 0);
  const by = new Map<string, Unit[]>();
  for (const u of units) pushTo(by, u.stratum, u);
  const out: Stratum[] = [];
  const rest: Unit[] = [];
  for (const [name, us] of [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const links = us.reduce((n, u) => n + u.links, 0);
    if (links < minShare * total) rest.push(...us);
    else out.push({ name, units: us, links });
  }
  if (rest.length) out.push({ name: "(שאר)", units: rest, links: rest.reduce((n, u) => n + u.links, 0) });
  for (const s of out) s.units.sort((a, b) => rankOf(seed, a.id) - rankOf(seed, b.id) || (a.id < b.id ? -1 : 1));
  return out;
}

/** n units allocated in proportion to the strata's links (largest remainder), at least 2 per stratum when it has them. */
export function allocate(strata: readonly Stratum[], n: number): Map<string, number> {
  const total = strata.reduce((a, s) => a + s.links, 0);
  const out = new Map<string, number>();
  const exact = strata.map((s) => ({ s, x: total ? (n * s.links) / total : 0 }));
  for (const { s, x } of exact) out.set(s.name, Math.min(s.units.length, Math.max(Math.min(2, s.units.length), Math.floor(x))));
  let left = n - [...out.values()].reduce((a, b) => a + b, 0);
  for (const { s } of [...exact].sort((a, b) => (b.x % 1) - (a.x % 1))) {
    if (left <= 0) break;
    if (out.get(s.name)! < s.units.length) out.set(s.name, out.get(s.name)! + 1), left--;
  }
  return out;
}

export const sizeBucket = (lines: number): string => (lines < 200 ? "<200" : lines < 2000 ? "200-2K" : lines < 20000 ? "2K-20K" : "20K+");
export const countBucket = (links: number): string => (links < 2 ? "1" : links < 10 ? "2-9" : links < 100 ? "10-99" : "100+");

// ─── scoring one book ────────────────────────────────────────────────────────────────────────────

export type Verdict = "correct" | "wrong" | "unconfirmed";
/** "structural": a pair engine took part (headings, dibur-hamatchil, footnotes); "citations": only the citations engine */
export type Group = "structural" | "citations";

export interface DbEnd {
  id: number;
  type: string;
  owner: Owner;
  /** the other book's id, and its lines */
  other: number;
  oFrom: number;
  oTo: number;
  /** the citation's words on THIS book's line (visible offsets), when the link carries them */
  span?: [number, number];
}

export interface ScoredSuggestion {
  s: Suggestion;
  /** the id that carries a citation's words ("…@start-end>…"): a merged suggestion's own id ("mx:…") does not */
  spanId: string;
  engines: readonly EngineId[];
  group: Group;
  verdict: Verdict;
  /** the dominant stored type of the DB links between the two books ("NONE": not linked at all) */
  pairType: string;
  bLine: number;
  other: number;
  oFrom: number;
  oTo: number;
}

export interface BookScore {
  scored: ScoredSuggestion[];
  /** "<type>|<owner>" → ids of the database links this book's run regenerated */
  matched: Map<string, Set<number>>;
  /** links at this book by line, for the miss analysis */
  byLine: Map<number, DbEnd[]>;
  /** the dominant stored type per other book */
  pairType: Map<number, string>;
}

const idOfKey = (key: string) => Number(key.slice(key.lastIndexOf(":") + 1));
const endOf = (s: LinkSide) => s.end ?? s.line;
/** a range of more lines than this on this book's side is indexed by its first lines only */
const MAX_RANGE = 2000;

/**
 * The database links at a book, keyed by the book's own lines. A link between two lines of the same
 * book is indexed both ways. `ownerOfLink` turns (type, stored source id, stored target id) into its owner.
 */
export function indexDbLinks(bookKey: string, links: readonly Link[], ownerOfLink: (type: string, s: number, t: number) => Owner): { byLine: Map<number, DbEnd[]>; pairType: Map<number, string> } {
  const byLine = new Map<number, DbEnd[]>();
  const typeCounts = new Map<number, Map<string, number>>();
  const add = (mine: LinkSide, other: LinkSide, e: Omit<DbEnd, "other" | "oFrom" | "oTo">) => {
    const end: DbEnd = { ...e, other: idOfKey(other.book.key), oFrom: other.line, oTo: endOf(other) };
    for (let l = mine.line; l <= Math.min(endOf(mine), mine.line + MAX_RANGE); l++) {
      const list = byLine.get(l);
      if (list) list.push(end);
      else byLine.set(l, [end]);
    }
    const m = typeCounts.get(end.other) ?? new Map<string, number>();
    m.set(e.type, (m.get(e.type) ?? 0) + 1);
    typeCounts.set(end.other, m);
  };
  for (const l of links) {
    const id = idOfKey(l.id);
    const type = l.declaredType.toUpperCase();
    const owner = ownerOfLink(type, idOfKey(l.source.book.key), idOfKey(l.target.book.key));
    const anchorOf = (side: 0 | 1): [number, number] | undefined => {
      const a = l.dbAnchors?.find((x) => x.side === side);
      return a ? [a.charStart, a.charEnd ?? a.charStart + 1] : undefined;
    };
    if (l.source.book.key === bookKey) {
      const span = anchorOf(0);
      add(l.source, l.target, { id, type, owner, ...(span && { span }) });
    }
    if (l.target.book.key === bookKey) {
      const span = anchorOf(1);
      add(l.target, l.source, { id, type, owner, ...(span && { span }) });
    }
  }
  const pairType = new Map<number, string>();
  for (const [other, m] of typeCounts) pairType.set(other, [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0]);
  return { byLine, pairType };
}

/** the citation's words in a citations suggestion (raw offsets in its id → visible offsets on the line) */
export function suggestionSpan(id: string, lineText: string | undefined): [number, number] | null {
  const m = /@(\d+)-(\d+)>/.exec(id);
  if (!m || lineText === undefined) return null;
  return [countVisibleChars(lineText, Number(m[1])), countVisibleChars(lineText, Number(m[2]))];
}

/**
 * Judges one book's merged max-link output against the links the database has at that book (in
 * either stored direction, any type):
 *   correct     — the database links the same line of this book to the same other book, and the
 *                 other ends intersect (a line in our range, or ours in the stored range; a citation's
 *                 whole cited unit, `citedSpan`, counts as ours);
 *   wrong       — the database links that line to that book, but elsewhere. For a citation only a
 *                 stored citation on the SAME words (LINKER anchors intersect) contradicts it; another
 *                 link of the line to that book says nothing about this mention (as measure.ts);
 *   unconfirmed — the database does not link that line to that book: a new link (or our error —
 *                 hand-checked, LIBRARY_BENCHMARK.md §4).
 */
export function scoreBook(
  bookKey: string,
  suggestions: readonly { s: Suggestion; engines: readonly EngineId[]; spanId?: string }[],
  db: { byLine: Map<number, DbEnd[]>; pairType: Map<number, string> },
  lineText: (line: number) => string | undefined,
): BookScore {
  const matched = new Map<string, Set<number>>();
  const scored: ScoredSuggestion[] = [];
  for (const { s, engines, spanId = s.id } of suggestions) {
    const sides: [LinkSide, LinkSide][] = [];
    if (s.source.book.key === bookKey) sides.push([s.source, s.target]);
    if (s.target.book.key === bookKey) sides.push([s.target, s.source]);
    if (!sides.length) continue;
    const group: Group = engines.some((e) => e !== "citations") ? "structural" : "citations";
    let verdict: Verdict = "unconfirmed";
    let first: [LinkSide, LinkSide] = sides[0]!;
    for (const [mine, other] of sides) {
      const oId = idOfKey(other.book.key);
      const oFrom = Math.min(other.line, s.citedSpan?.line ?? other.line);
      const oTo = Math.max(endOf(other), s.citedSpan?.end ?? endOf(other));
      const here: DbEnd[] = [];
      for (let l = mine.line; l <= Math.min(endOf(mine), mine.line + MAX_RANGE); l++) for (const e of db.byLine.get(l) ?? []) if (e.other === oId) here.push(e);
      if (!here.length) continue;
      const hits = here.filter((e) => e.oFrom <= oTo && oFrom <= e.oTo);
      if (hits.length) {
        verdict = "correct";
        first = [mine, other];
        for (const h of hits) {
          const k = `${h.type}|${h.owner}`;
          const set = matched.get(k);
          if (set) set.add(h.id);
          else matched.set(k, new Set([h.id]));
        }
        continue;
      }
      if (verdict === "correct") continue;
      if (group === "citations") {
        const span = suggestionSpan(spanId, lineText(mine.line));
        const sameWords = here.some((e) => e.type === "LINKER" && (!e.span || !span || (e.span[0] < span[1] && span[0] < e.span[1])));
        if (sameWords) verdict = "wrong";
      } else verdict = "wrong";
    }
    const [mine, other] = first;
    const oId = idOfKey(other.book.key);
    scored.push({ s, spanId, engines, group, verdict, pairType: db.pairType.get(oId) ?? "NONE", bLine: mine.line, other: oId, oFrom: other.line, oTo: endOf(other) });
  }
  return { scored, matched, byLine: db.byLine, pairType: db.pairType };
}

// ─── compact storage ─────────────────────────────────────────────────────────────────────────────

/** sorted ids as base-36 deltas ("1a.3.f") */
export function encodeIds(ids: Iterable<number>): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  return sorted.map((x, i) => (x - (i ? sorted[i - 1]! : 0)).toString(36)).join(".");
}

export function decodeIds(s: string): number[] {
  if (!s) return [];
  let acc = 0;
  return s.split(".").map((d) => (acc += parseInt(d, 36)));
}

/** counters of verdicts, keyed "<group>|<confidence>|<pairType>" → [n, correct, wrong, unconfirmed] */
export type Counters = Record<string, [number, number, number, number]>;

export function count(scored: readonly ScoredSuggestion[]): Counters {
  const out: Counters = {};
  for (const x of scored) {
    const c = (out[`${x.group}|${x.s.confidence}|${x.pairType}`] ??= [0, 0, 0, 0]);
    c[0]++;
    c[x.verdict === "correct" ? 1 : x.verdict === "wrong" ? 2 : 3]++;
  }
  return out;
}

export function addCounters(into: Counters, from: Counters): void {
  for (const [k, v] of Object.entries(from)) {
    const c = (into[k] ??= [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) c[i]! += v[i]!;
  }
}

// ─── estimates ───────────────────────────────────────────────────────────────────────────────────

export interface Observation {
  /** links in scope, links regenerated */
  scope: number;
  matched: number;
}

export interface Estimate {
  recall: number;
  /** half-width of the 95% interval */
  ci: number;
  units: number;
  scope: number;
  matched: number;
}

/**
 * Stratified ratio estimate: per stratum R_h = Σ matched / Σ scope over its sampled units, combined
 * with the strata's link totals as weights. Variance: the ratio estimator's, with the finite
 * population correction (a fully sampled stratum contributes none).
 */
export function estimate(strata: readonly { links: number; population: number; obs: readonly Observation[] }[]): Estimate {
  const total = strata.reduce((a, s) => a + (s.obs.length ? s.links : 0), 0);
  let recall = 0;
  let variance = 0;
  let units = 0;
  let scope = 0;
  let matched = 0;
  for (const s of strata) {
    const n = s.obs.length;
    if (!n || !total) continue;
    const S = s.obs.reduce((a, o) => a + o.scope, 0);
    const M = s.obs.reduce((a, o) => a + o.matched, 0);
    units += n;
    scope += S;
    matched += M;
    const R = S ? M / S : 0;
    const w = s.links / total;
    recall += w * R;
    if (n > 1 && S) {
      const mean = S / n;
      const ss = s.obs.reduce((a, o) => a + (o.matched - R * o.scope) ** 2, 0) / (n - 1);
      const fpc = Math.max(0, 1 - n / s.population);
      variance += w * w * (fpc * ss) / (n * mean * mean);
    }
  }
  return { recall, ci: 1.96 * Math.sqrt(variance), units, scope, matched };
}

export const CONFIDENCES: readonly Confidence[] = ["certain", "high", "possible", "ambiguous"];

/** the visible text of a line with tags removed, `[…]` around [a, b) (visible offsets), cut around it */
export function excerpt(html: string | undefined, span?: [number, number] | null, width = 90): string {
  if (html === undefined) return "";
  const units: string[] = [];
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i]!;
    if (ch === "<" && html.indexOf(">", i) > 0) inTag = true;
    if (!inTag) {
      if (ch === "&") {
        const semi = html.indexOf(";", i);
        if (semi > i && semi - i < 10) {
          units.push(" ");
          i = semi;
          continue;
        }
      }
      units.push(ch);
    }
    if (ch === ">") inTag = false;
  }
  if (!span) return units.slice(0, width * 2).join("").trim();
  const [a, b] = span;
  return `${units.slice(Math.max(0, a - width), a).join("")}[${units.slice(a, b).join("")}]${units.slice(b, b + width).join("")}`.trim();
}
