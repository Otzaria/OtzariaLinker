import { pushTo } from "../core/collections";
import { linePairIdentity } from "../core/links/equality";
import type { LinkSide, RawAnchor } from "../core/links/model";
import { capSpanned, CONFIDENCE_LABELS, CONFIDENCE_ORDER, ENGINES, type Candidate, type Confidence, type EngineId, type MatchedWords, type Reason, type Suggestion } from "./automatic";

/*
 * Merging the suggestions of many engine runs into ONE list (max-link, stage 8.4). Pure, and a
 * function of the multiset of raw suggestions only: the result does not depend on their order, and
 * merging a merged list again gives the same list (each merged suggestion carries its raw members).
 *
 * "The same link" is the generator's notion, not the record's: the same two line positions (with
 * ranges), in either direction and of any type — the dibur-hamatchil engine writes base → commentary
 * with a word anchor where the headings engine writes commentary → base, and Otzaria stores both as
 * one COMMENTARY link (AUTOMATION_ENGINE.md §3). Keeping both would be a duplicate link in the library.
 * The one exception: when ONE engine gave several suggestions for the same two lines (footnotes: two
 * markers on a line pointing at the same note), they stay separate, told apart by their anchors.
 *
 * Confidence, precision first:
 *   - two or more engines on the exact same link, each at least "possible": one step up
 *     (possible → high → certain). Ambiguous or "none" members never count as support.
 *   - a link inside a coarser one at the same position (headings: the whole verse range; dh: one
 *     line in it) is CONSISTENT: the coarse one is folded into the precise one, which may rise from
 *     "possible" to "high" — never to "certain".
 *   - different, non-nested targets for the same position (focus line and anchor, same target book)
 *     from different engines are a CONFLICT. It is SETTLED when the evidence says who is right (step
 *     4c, `settle`): the only "certain" side, or else the only side placed by the line's own words
 *     (a quote of the base, a reference it writes out) against sides placed by the books' layout. The
 *     winner pays one step for being contradicted (certain → high, high → possible, never above its
 *     own level), and every other side is folded into it as an alternative with the reason — kept
 *     among its members, not dropped. An unsettled conflict sends every side to "ambiguous", with the
 *     others as alternatives. Ambiguous suggestions are never approved in bulk.
 * Only "certain" is approved in bulk (store.suggestions.pendingAtLeast("certain")); nothing here changes that.
 *
 * Single-book engines (citations) say something of another kind: a commentary line on verse 1 that
 * CITES verse 2 is two true links, not a conflict. Their position carries the citation's span, so they
 * never conflict with, fold into, or absorb a structural engine's suggestion at the same line, and they
 * do not count in the per-pair statistics (steps 4 and 4b) that judge whether a book's STRUCTURE fits
 * its base. They still join a structural engine's suggestion on the very same two lines (an agreement).
 */

/** A raw suggestion and the book its step read as the input source (the commentary, the main book, the single book). */
export interface MergeItem {
  readonly suggestion: Suggestion;
  /** key of that book: its end of the suggestion is the "position" conflicts are judged at */
  readonly focus: string;
}

export interface MergedSuggestion extends Suggestion {
  /** engines that produced this exact link, in ENGINES order */
  readonly engines: readonly EngineId[];
  /** the raw suggestions behind it (exact duplicates and folded coarser ones), for re-merging and the report */
  readonly members: readonly MergeItem[];
  /** the focus book of the representative (the book this link is reported under) */
  readonly focus: string;
  /** every piece of evidence behind it, where it came from, and whether it counted toward the confidence (#41 B1) */
  readonly evidence?: readonly MergeEvidence[];
}

/**
 * What a piece of evidence rests on (#41 B1). A ד"ה searched inside the section the commentary's own headings name
 * ("words-in-heading-window") or inside the one numbered line a heading names ("words-in-unit") is found there by
 * construction: inside the headings engine's range, or on its line, it adds nothing the headings did not already say.
 * Only a search of the whole base ("words-whole-book"), or a words engine without a structural window ("words"), is
 * independent of the layout ("structure").
 */
export type EvidenceBasis = "structure" | "words-whole-book" | "words-in-heading-window" | "words-in-unit" | "words-unknown-window" | "words";

export interface MergeEvidence {
  readonly engine: EngineId;
  /** representative: the record written; agrees: the same link from another engine; containing: a coarser range around it; inner: a finer place inside it, kept as an alternative; outweighed: the loser of a settled conflict */
  readonly role: "representative" | "agrees" | "containing" | "inner" | "outweighed";
  readonly confidence: Confidence;
  readonly basis: EvidenceBasis;
  /** lines of the other book it points at (1 for a single line) */
  readonly width: number;
  /** it raised or carried the confidence of this suggestion */
  readonly counted: boolean;
}

/**
 * A coarser range of another engine around a precise line raises it ("possible" → "high", never higher) only when the
 * precise line was found independently of that range AND the range is at most this many lines: landing inside a whole
 * siman (dozens of lines) by chance is not unlikely enough to be evidence. NOT calibrated: the V7 matching benchmark
 * (docs/validation/V7_MATCHING_BENCHMARK.md) has almost no whole-base ד"ה inside a headings range (a commentary with headings
 * is searched inside them). 20 is the widest span written line by line on a Sefaria base (SPAN_EACH_LINE_MAX) and the bound of
 * "high" for a headings range (headings/consistency.ts RANGE_WIDTH).
 */
export const CONTAINMENT_MAX_WIDTH = 20;

export type ExistingWhere = "db" | "project";

export interface MergeOptions {
  /** where the link already exists, judged on the FINAL suggestion (its id included), or null */
  existing?: (s: Suggestion) => ExistingWhere | null;
  /**
   * linePairKey of links the library already has (the database's links of the books read). A book
   * pair whose suggestions mostly CONTRADICT them is suspect (REFERENCE_DISAGREEMENT).
   */
  reference?: Iterable<string>;
  /**
   * Keys of books the user chose as alternative targets of the same commentary (an explicit multi-target run,
   * plan.ts PlanChoices.pairs). A line that has suggestions in two of them is never linked to both blindly: the
   * more certain one wins (one step down, so it is not approved in bulk) and the other is folded in as its
   * alternative; equally sure ones both stay "ambiguous", each naming the other (step 4d).
   */
  candidateBooks?: Iterable<string>;
}

export interface MergeStats {
  /** raw suggestions in (after dropping repeats of the same id) */
  input: number;
  /** suggestions out */
  output: number;
  /** input − output: exact duplicates and coarse ones folded into a precise one */
  duplicates: number;
  /** outputs that two or more engines agree on */
  agreements: number;
  /** outputs whose confidence rose through agreement or consistency */
  raised: number;
  /** outputs that absorbed a coarser suggestion */
  consistent: number;
  /** outputs lowered to "ambiguous" by a conflict nobody won */
  conflicts: number;
  /** outputs that won a conflict (settle): the only certain side, or the only one placed by the line's words */
  settled: number;
  /** suggestions that lost a conflict and were folded into the winner as its alternatives */
  outweighed: number;
  /** outputs that already exist (db / project) at merge time */
  existing: number;
  /** book pairs where the engines disagree on most lines (PAIR_DISAGREEMENT): no single-engine "certain" there */
  suspectPairs: number;
  /** book pairs whose suggestions mostly contradict the library's own links (REFERENCE_DISAGREEMENT): no "certain" there */
  contradictedPairs: number;
}

export interface MergeResult {
  suggestions: MergedSuggestion[];
  stats: MergeStats;
}

/**
 * "These two lines are already linked": both ends, in either direction and of any type. A suggestion
 * that only differs from an existing link by type (the library stores Onkelos as TARGUM) or by file
 * direction adds nothing, so it shows as "already exists".
 */
export function linePairKey(l: { source: LinkSide; target: LinkSide }): string {
  return linePairIdentity(l);
}

const ENGINE_ORDER = new Map<string, number>(ENGINES.map((e, i) => [e.id, i]));
/** representative preference among equally confident members: a word anchor on the base is the richer record */
const REP_PRIORITY: readonly string[] = ["dibur-hamatchil", "headings", "footnotes"];
const engineRank = (e: string) => ENGINE_ORDER.get(e) ?? ENGINES.length;
const repRank = (e: string) => {
  const i = REP_PRIORITY.indexOf(e);
  return i === -1 ? REP_PRIORITY.length + engineRank(e) : i;
};
const rank = (c: Confidence) => CONFIDENCE_ORDER.indexOf(c);
const POSSIBLE = rank("possible");
const AMBIGUOUS = rank("ambiguous");

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);
const endOf = (s: LinkSide) => s.end ?? s.line;
const endKey = (s: LinkSide) => `${s.book.key}#${s.line}-${endOf(s)}`;
const anchorKey = (s: Suggestion) => (s.anchor ? `${s.source.book.key}#${s.source.line}@${s.anchor.rawStart}` : "");

interface Raw {
  s: Suggestion;
  focus: string;
  /** the focus end and the other end of this suggestion */
  fEnd: LinkSide;
  oEnd: LinkSide;
  /** the place the other end stands for: oEnd, or the whole span a collapsed range kept (`citedSpan`, sefaria-owned.ts withoutRange) */
  oSpan: LinkSide;
  fAnchor: RawAnchor | undefined;
}

function toRaw(it: MergeItem): Raw {
  const s = it.suggestion;
  const focusIsTarget = s.target.book.key === it.focus && s.source.book.key !== it.focus;
  const oEnd = focusIsTarget ? s.source : s.target;
  const oSpan = s.citedSpan && oEnd === s.target ? { ...oEnd, line: s.citedSpan.line, end: s.citedSpan.end } : oEnd;
  return { s, focus: it.focus, fEnd: focusIsTarget ? s.target : s.source, oEnd, oSpan, fAnchor: focusIsTarget ? undefined : s.anchor };
}

/** The raw items behind a list that may already be merged. */
export function mergeItems(list: readonly (MergeItem | MergedSuggestion)[]): MergeItem[] {
  return list.flatMap((x) => ("members" in x ? x.members : [x as MergeItem]));
}

function preferItem(a: MergeItem, b: MergeItem): number {
  const [x, y] = [a.suggestion, b.suggestion];
  return cmp(a.focus, b.focus) || rank(x.confidence) - rank(y.confidence) || y.score - x.score || cmp(JSON.stringify(x), JSON.stringify(y));
}

interface Group {
  id: string;
  exact: Raw[];
  rep: Raw;
  engines: EngineId[];
  position: string;
  /** coarser suggestions folded into this one */
  consistent: Raw[];
  /** finer but weak (ambiguous) suggestions inside this one's range, kept as alternatives */
  inner: Raw[];
  folded: boolean;
  conflictWith: Group[];
  /** the sides this one won a conflict against (settle), folded into it as alternatives */
  outweighs: Group[];
  /** why it won: the only certain side, or the only one placed by the line's words */
  wonBy?: "certain" | "words" | "candidates";
  /** made only of single-book engines (citations): outside the structural statistics */
  single: boolean;
  /** the same line's equally sure suggestions in the user's other candidate books (candidateBooks, step 4d) */
  multi: Group[];
}

/*
 * The representative is the record that gets written. A single-book engine (citations) is never it
 * while a structural engine (headings, dibur-hamatchil…) is in the group, whatever the confidences:
 * the citation says REFERENCE where the structural engine says COMMENTARY/source, the generator keeps
 * the type in the link identity (Generator.kt:2292-2300), and a REFERENCE moves the link from the
 * commentators panel to the links panel (compatibility review B4). The citation still counts as
 * agreement (engines, confidence), it only does not choose the record.
 */
const better = (a: Raw, b: Raw) =>
  Number(isSingleBook(a.s.engine)) - Number(isSingleBook(b.s.engine)) ||
  rank(a.s.confidence) - rank(b.s.confidence) || repRank(a.s.engine) - repRank(b.s.engine) || b.s.score - a.s.score || cmp(a.s.id, b.s.id);

function makeGroup(id: string, exact: Raw[]): Group {
  const rep = [...exact].sort(better)[0]!;
  const engines = [...new Set(exact.map((r) => r.s.engine))].sort((a, b) => engineRank(a) - engineRank(b));
  const single = engines.every(isSingleBook);
  // a citation's span is in its id ("…@start-end>…") even without an anchor: two mentions, two positions
  const span = single ? (rep.fAnchor ? `@${rep.fAnchor.rawStart}` : /@\d+-\d+>/.exec(rep.s.id)?.[0] ?? `@${rep.s.id}`) : rep.fAnchor ? `@${rep.fAnchor.rawStart}` : "";
  const position = `${single ? "single:" : ""}${endKey(rep.fEnd)}${span}>${rep.oEnd.book.key}`;
  return { id, exact, rep, engines, position, consistent: [], inner: [], folded: false, conflictWith: [], outweighs: [], single, multi: [] };
}

/** an engine that reads one book and links into all open books (ENGINES[].singleBook) */
const isSingleBook = (e: EngineId) => ENGINES.find((x) => x.id === e)?.singleBook === true;
/** an engine that places a line by its own words: a quote, a written reference (ENGINES[].evidence) */
const byWords = (e: EngineId) => ENGINES.find((x) => x.id === e)?.evidence === "words";

/** What a raw suggestion rests on: the ד"ה engine's own search window (dh/window-<kind>, engine.ts), or its engine's kind of evidence. */
function basisOf(s: Suggestion): EvidenceBasis {
  if (s.engine === "dibur-hamatchil") {
    if (s.rules.includes("dh/window-unit") || s.rules.includes("dh/unit-label")) return "words-in-unit";
    if (s.rules.some((x) => x === "dh/window-heading" || x === "dh/window-page" || x === "dh/window-caller")) return "words-in-heading-window";
    if (s.rules.includes("dh/window-book")) return "words-whole-book";
    // a line that inherits its place (בא"ד, שם), or a result without the rule: the window is not known
    return "words-unknown-window";
  }
  return byWords(s.engine) ? "words" : "structure";
}

/**
 * The source of a piece of evidence for an EXACT agreement: a ד"ה searched only inside the numbered line a heading names
 * says what the heading says (its window is that line), so with the headings engine it is one source, not two.
 * A ד"ה searched in a whole section picks its line by the words — a second source next to the heading's number.
 */
const agreementSource = (x: Raw): string => (basisOf(x.s) === "words-in-unit" || basisOf(x.s) === "structure" ? "structure" : x.s.engine);

/**
 * The precise line `x` is evidence about the coarse range `around` only when it was found without it: a search of the
 * whole base (or a words engine without a structural window) against a range of the layout. A ד"ה found inside the
 * section the headings name is inside their range by construction; a window that is not known counts as dependent.
 */
const independentOf = (x: Raw, around: Raw): boolean => {
  const bx = basisOf(x.s);
  const ba = basisOf(around.s);
  if (ba !== "structure" && bx !== "structure") return false; // two searches by the words: the same kind of evidence
  if (ba === "structure") return bx === "words-whole-book" || bx === "words";
  return bx === "structure"; // a heading's line inside a quote's span: number and words, two sources
};

const widthOf = (s: LinkSide) => endOf(s) - s.line + 1;

/** a coarser range that raises the precise group: at least "high", narrow enough, and found independently of a supporting member */
const confirms = (g: Group, around: Raw): boolean =>
  rank(around.s.confidence) <= rank("high") && widthOf(around.oSpan) <= CONTAINMENT_MAX_WIDTH && g.exact.some((x) => rank(x.s.confidence) <= POSSIBLE && independentOf(x, around));

/** the best confidence of a group's own exact members */
const ownLevel = (g: Group) => Math.min(...g.exact.map((x) => rank(x.s.confidence)));

/** two or more INDEPENDENT sources agree on the exact link, each at least "possible" (agreementSource) */
const agreeing = (g: Group): Raw[] | null => {
  const support = g.exact.filter((x) => rank(x.s.confidence) <= POSSIBLE);
  return new Set(support.map(agreementSource)).size > 1 ? support : null;
};

/**
 * A group's confidence before any conflict: its best member, one step up when two independent sources agree on the
 * exact link (each at least "possible"), "high" at most when a narrow coarser range of another engine contains it and the
 * precise line was found without that range (confirms; #41 B1).
 */
function supportLevel(g: Group): number {
  let level = ownLevel(g);
  const support = agreeing(g);
  if (support) level = Math.max(0, Math.min(...support.map((x) => rank(x.s.confidence))) - 1);
  if (level === POSSIBLE && g.consistent.some((x) => confirms(g, x))) level = rank("high");
  return level;
}

/**
 * Who wins a conflict at one position (the sides are pairwise in conflict), or null. Measured on the
 * library benchmark's development books (AUTOMATION_ENGINE.md §5.3.1), where nearly every conflict is
 * headings against dibur-hamatchil:
 *   1. the only "certain" side — unless the book pair is suspect or contradicts the library (steps 4, 4b):
 *      there a "certain" heading is the very thing in doubt (the Rif's own dapim read as the Talmud's);
 *   2. otherwise, the only side placed by the line's own words (a quote of the base) against
 *      sides placed by the layout alone — at every level of either side, even an "ambiguous" quote
 *      against a "high" heading: a commentary's heading numbers are read as the base's far more often
 *      than its quote is found in the wrong place.
 * Two certain sides, or not exactly one side placed by the words, stay a conflict.
 */
function settle(sides: readonly Group[], structureInDoubt: boolean): { winner: Group; by: "certain" | "words" } | null {
  const certain = structureInDoubt ? [] : sides.filter((g) => supportLevel(g) === 0);
  if (certain.length) return certain.length === 1 ? { winner: certain[0]!, by: "certain" } : null;
  const words = sides.filter((g) => g.exact.some((x) => byWords(x.s.engine)));
  return words.length === 1 ? { winner: words[0]!, by: "words" } : null;
}

/**
 * When, between the same two books, the lines on which two engines both spoke conflict this often, the
 * pair is suspect. Measured on all commentaries of Bavli Berakhot in the full library: the Rif (its own
 * dapim) — see AUTOMATION_ENGINE.md §5.6.
 */
export const PAIR_DISAGREEMENT = { minConflicts: 10, ratio: 0.25 } as const;
/**
 * When the library already links a book pair and our suggestions point elsewhere on this share of the
 * lines it links (at least `minJudged` lines), the structure the engines read is not the base's. Measured
 * on Bavli Berakhot: the Rif and the Ra'ah, numbered by the Rif's own dapim, contradict the database on
 * most lines — both engines are fooled alike (dibur-hamatchil searches inside the same-named heading),
 * so their agreement proves nothing there. Every other commentary stays far below (AUTOMATION_ENGINE.md §5.6).
 */
export const REFERENCE_DISAGREEMENT = { minJudged: 20, ratio: 0.25 } as const;
/**
 * A place of the other book that at least this many lines of the focus book are linked to, in the library, is COARSE (a whole siman, a
 * whole chapter): it stands for the stretch of the book up to the next place the library names. An exact suggestion inside that stretch
 * refines the library's link; it does not contradict it (fix round, claim 10). A place linked from fewer lines is an exact link, and a
 * different line is a contradiction, as before. The stretch of the LAST coarse place has no next place to end it, so it is as long as the
 * longest stretch seen in the same pair (and a pair with one coarse place and nothing after it has none: nothing says how far it reaches).
 */
export const COARSE_PLACE_MIN = 3;
const bookPair = (g: Group) => `${g.rep.fEnd.book.key}>${g.rep.oEnd.book.key}`;

/** at least one member is "possible" or better: ambiguous and "none" give no support */
const strong = (g: Group) => g.exact.some((x) => rank(x.s.confidence) <= POSSIBLE);

/**
 * The other end as grouping sees it: a structural engine's range collapsed on a Sefaria side is still its
 * span, as the range was — a heading's section starting on a ד"ה line is CONTAINING it (consistent, at
 * most "high"), not the same link (an agreement that would raise it to "certain"). A citation keeps its
 * written line: it joins a structural suggestion on the very same two lines, as before.
 */
const keyEnd = (r: Raw) => (isSingleBook(r.s.engine) ? r.oEnd : r.oSpan);

/** a's other end strictly contains b's (same book is implied by the shared position); a range collapsed on a Sefaria side counts as its whole span */
const contains = (a: Group, b: Group) => {
  const [x, y] = [a.rep.oSpan, b.rep.oSpan];
  return x.line <= y.line && endOf(x) >= endOf(y) && (x.line !== y.line || endOf(x) !== endOf(y));
};

export function mergeSuggestions(items: readonly (MergeItem | MergedSuggestion)[], opts: MergeOptions = {}): MergeResult {
  // 1. raw items, each id once, in a canonical order (order-independence starts here)
  const byId = new Map<string, MergeItem>();
  for (const it of mergeItems(items)) {
    const k = `${it.suggestion.engine}|${it.suggestion.id}`;
    const prev = byId.get(k);
    // the same id twice (a step planned twice, a list merged with its own members): keep one, chosen by content
    if (!prev || preferItem(it, prev) < 0) byId.set(k, it);
  }
  const raws = [...byId.entries()].sort(([a], [b]) => cmp(a, b)).map(([, it]) => toRaw(it));

  // 2. the same two line positions → one group; one engine with several suggestions there → split by anchor
  const byPair = new Map<string, Raw[]>();
  for (const r of raws) {
    const a = endKey(r.s.source === r.oEnd ? keyEnd(r) : r.s.source);
    const b = endKey(r.s.target === r.oEnd ? keyEnd(r) : r.s.target);
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    const list = byPair.get(k);
    if (list) list.push(r);
    else byPair.set(k, [r]);
  }
  const groups: Group[] = [];
  for (const k of [...byPair.keys()].sort()) {
    const list = byPair.get(k)!;
    const perEngine = new Map<string, Raw[]>();
    for (const r of list) pushTo(perEngine, r.s.engine, r);
    const seeder = [...perEngine.entries()].sort(([ea, a], [eb, b]) => b.length - a.length || engineRank(ea) - engineRank(eb) || cmp(ea, eb))[0]!;
    if (seeder[1].length < 2) {
      groups.push(makeGroup(`mx:${k}`, list));
      continue;
    }
    const seeds = [...seeder[1]].sort((a, b) => cmp(anchorKey(a.s), anchorKey(b.s)) || cmp(a.s.id, b.s.id));
    const parts = seeds.map((s) => [s]);
    for (const r of list) {
      if (r.s.engine === seeder[0]) continue;
      const i = seeds.findIndex((s) => anchorKey(s.s) === anchorKey(r.s));
      parts[i === -1 ? 0 : i]!.push(r);
    }
    seeds.forEach((s, i) => groups.push(makeGroup(`mx:${k}@${anchorKey(s.s) || s.s.id}`, parts[i]!)));
  }

  // 3. groups at the same position: fold coarse into precise, mark conflicts between different engines
  const byPos = new Map<string, Group[]>();
  for (const g of groups) pushTo(byPos, g.position, g);
  for (const at of byPos.values()) {
    if (at.length < 2) continue;
    // a precise suggestion with support absorbs the coarse range around it (which stays among its members and its
    // alternatives, finalize; whether it raises the precise one is supportLevel's question, #41 B1)…
    for (const a of at)
      for (const b of at)
        if (a !== b && contains(a, b) && (strong(b) || !strong(a))) {
          b.consistent.push(...a.exact); // containment is transitive: b also meets every group that contains a
          a.folded = true;
        }
    // …but an ambiguous one inside a supported range does not replace it: it becomes its alternative
    for (const a of at)
      for (const b of at)
        if (a !== b && !a.folded && !b.folded && contains(a, b)) {
          // everything b holds moves with it — what it absorbed in the first pass too, or that would be lost
          a.inner.push(...b.exact, ...b.consistent, ...b.inner);
          b.folded = true;
        }
    const live = at.filter((g) => !g.folded);
    for (const a of live)
      for (const b of live)
        if (a !== b && !contains(a, b) && !contains(b, a) && (a.engines.some((e) => !b.engines.includes(e)) || b.engines.some((e) => !a.engines.includes(e)))) a.conflictWith.push(b);
  }

  // 4. book pairs whose engines mostly disagree: one engine's structure does not fit (the Rif's own dapim
  //    read as the Talmud's), so no single engine's "certain" there is trusted
  //    counted per POSITION (a commentary line): engines in conflict there, or agreeing (exactly or by containment)
  const perPair = new Map<string, { conflicts: number; support: number }>();
  for (const at of byPos.values()) {
    const live = at.filter((g) => !g.folded && !g.single);
    if (!live.length) continue;
    const k = bookPair(live[0]!);
    const c = perPair.get(k) ?? { conflicts: 0, support: 0 };
    if (live.some((g) => g.conflictWith.length)) c.conflicts++;
    else if (live.some((g) => g.engines.length > 1 || g.consistent.length)) c.support++;
    perPair.set(k, c);
  }
  const suspect = new Set([...perPair].filter(([, c]) => c.conflicts >= PAIR_DISAGREEMENT.minConflicts && c.conflicts / (c.conflicts + c.support) >= PAIR_DISAGREEMENT.ratio).map(([k]) => k));

  // 4b. the same against the links the library already has: per book pair, how many of the lines it
  //     links do our suggestions send elsewhere
  const refLines = new Map<string, number[]>(); // "<book>#<line>><other book>" → lines of the other book
  for (const key of opts.reference ?? []) {
    const [a, b] = key.split("|") as [string, string];
    for (const [x, y] of [[a, b], [b, a]] as const) {
      const at = y.lastIndexOf("#");
      const k = `${x}>${y.slice(0, at)}`;
      const list = refLines.get(k);
      if (list) list.push(Number(y.slice(at + 1)));
      else refLines.set(k, [Number(y.slice(at + 1))]);
    }
  }
  // per book pair (by title, like the reference keys): how many focus lines the library links to each line of the other book. A line with
  // COARSE_PLACE_MIN or more is a coarse place: it stands for the stretch up to the next line the library names
  const sections = new Map<string, { starts: number[]; ends: number[] }>();
  if (refLines.size) {
    const perPair = new Map<string, Map<number, number>>();
    for (const [k, lines] of refLines) {
      const pairKey = `${k.slice(0, k.lastIndexOf("#"))}>${k.slice(k.lastIndexOf(">") + 1)}`;
      const m = perPair.get(pairKey) ?? new Map<number, number>();
      for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
      perPair.set(pairKey, m);
    }
    for (const [pairKey, m] of perPair) {
      const known = [...m.keys()].sort((a, b) => a - b);
      const coarse = known.filter((l) => m.get(l)! >= COARSE_PLACE_MIN);
      if (!coarse.length) continue;
      const ends = coarse.map((l) => (known[known.indexOf(l) + 1] ?? Infinity) - 1);
      const longest = Math.max(0, ...coarse.map((l, i) => (ends[i]! === Infinity ? 0 : ends[i]! - l + 1)));
      // the last place has no next one: as long as the longest stretch seen, or no reach at all when none was seen
      sections.set(pairKey, { starts: coarse, ends: ends.map((e, i) => (e === Infinity ? coarse[i]! + Math.max(0, longest - 1) : e)) });
    }
  }
  const versus = new Map<string, { judged: number; contradicted: number }>();
  if (refLines.size)
    for (const g of groups) {
      if (g.folded || g.single) continue;
      const known = refLines.get(`${g.rep.fEnd.book.title}#${g.rep.fEnd.line}>${g.rep.oEnd.book.title}`); // reference keys are linePairKey: book TITLES (the one equality rule)
      if (!known) continue;
      const v = versus.get(bookPair(g)) ?? { judged: 0, contradicted: 0 };
      v.judged++;
      const coarse = sections.get(`${g.rep.fEnd.book.title}>${g.rep.oEnd.book.title}`);
      const refinesCoarse = (l: number) => {
        const i = coarse?.starts.indexOf(l) ?? -1;
        return i >= 0 && coarse!.starts[i]! <= g.rep.oSpan.line && endOf(g.rep.oSpan) <= coarse!.ends[i]!;
      };
      if (!known.some((l) => (l >= g.rep.oSpan.line && l <= endOf(g.rep.oSpan)) || refinesCoarse(l))) v.contradicted++;
      versus.set(bookPair(g), v);
    }
  const contradicted = new Map([...versus].filter(([, v]) => v.judged >= REFERENCE_DISAGREEMENT.minJudged && v.contradicted / v.judged >= REFERENCE_DISAGREEMENT.ratio));

  // 4c. conflicts the evidence settles (settle): the losers are folded into the winner as its alternatives.
  //     After 4 and 4b, which count every conflict: a book pair whose structure does not fit stays suspect.
  for (const at of byPos.values()) {
    const sides = at.filter((g) => !g.folded && g.conflictWith.length);
    if (sides.length < 2) continue;
    const settled = settle(sides, suspect.has(bookPair(sides[0]!)) || contradicted.has(bookPair(sides[0]!)));
    if (!settled) continue;
    const { winner } = settled;
    winner.wonBy = settled.by;
    for (const g of sides)
      if (g !== winner && winner.conflictWith.includes(g)) {
        winner.outweighs.push(g);
        g.folded = true;
      }
  }

  // 4d. a line with suggestions in several of the user's candidate books: one winner or none, never all blindly
  const candidates = new Set(opts.candidateBooks ?? []);
  if (candidates.size > 1) {
    const byLine = new Map<string, Group[]>();
    for (const g of groups) if (!g.folded && !g.single && candidates.has(g.rep.oEnd.book.key)) pushTo(byLine, `${g.rep.fEnd.book.key}#${g.rep.fEnd.line}`, g);
    for (const at of [...byLine.keys()].sort().map((k) => byLine.get(k)!)) {
      if (new Set(at.map((g) => g.rep.oEnd.book.key)).size < 2) continue;
      const ranked = [...at].sort((a, b) => supportLevel(a) - supportLevel(b) || b.rep.s.score - a.rep.s.score || cmp(a.id, b.id));
      const [best, second] = [ranked[0]!, ranked.find((g) => g.rep.oEnd.book.key !== ranked[0]!.rep.oEnd.book.key)!];
      if (supportLevel(best) < supportLevel(second)) {
        // an earlier settle (4c) keeps its own reason; the candidates' one is only for a group that won nothing yet
        best.wonBy ??= "candidates";
        for (const g of ranked) if (g !== best && g.rep.oEnd.book.key !== best.rep.oEnd.book.key) (best.outweighs.push(g), (g.folded = true));
      } else {
        // the equally sure ones name each other; a less sure candidate is left as it is
        const tied = at.filter((g) => supportLevel(g) === supportLevel(best));
        for (const g of tied) g.multi = tied.filter((o) => o !== g && o.rep.oEnd.book.key !== g.rep.oEnd.book.key);
      }
    }
  }

  // 5. one suggestion per live group
  const stats: MergeStats = { input: raws.length, output: 0, duplicates: 0, agreements: 0, raised: 0, consistent: 0, conflicts: 0, settled: 0, outweighed: 0, existing: 0, suspectPairs: suspect.size, contradictedPairs: contradicted.size };
  const out: MergedSuggestion[] = [];
  for (const g of groups) {
    if (g.folded) continue;
    const s = finalize(g, stats, opts, suspect.has(bookPair(g)) ? perPair.get(bookPair(g))! : null, contradicted.get(bookPair(g)) ?? null);
    out.push(s);
  }
  out.sort((a, b) => {
    const [ra, rb] = [toRaw({ suggestion: a, focus: a.focus }), toRaw({ suggestion: b, focus: b.focus })];
    return cmp(ra.fEnd.book.key, rb.fEnd.book.key) || ra.fEnd.line - rb.fEnd.line || (ra.fAnchor?.rawStart ?? -1) - (rb.fAnchor?.rawStart ?? -1) || cmp(ra.oEnd.book.key, rb.oEnd.book.key) || ra.oEnd.line - rb.oEnd.line || cmp(a.id, b.id);
  });
  stats.output = out.length;
  stats.duplicates = stats.input - stats.output;
  return { suggestions: out, stats };
}

const TITLE = new Map(ENGINES.map((e) => [e.id, e.title]));
const engineTitle = (e: EngineId) => `"${TITLE.get(e) ?? e}"`;
const r = (code: string, text: string): Reason => ({ code, text });

/**
 * The matched words of a group: the representative's own, else those of the member that has them (an engine that
 * places a line by its words, next to one that places it by its layout), turned to the representative's sides when
 * that member writes the link the other way round (the anchored record is base → commentary).
 */
function matchedOf(g: Group): MatchedWords | undefined {
  if (g.rep.s.matched) return g.rep.s.matched;
  const from = g.exact.find((x) => x.s.matched);
  if (!from) return undefined;
  const m = from.s.matched!;
  return from.s.source.book.key === g.rep.s.source.book.key ? m : { ...(m.target && { source: m.target }), ...(m.source && { target: m.source }) };
}

/** where another group's suggestion points: its line, and its book when that is not the winner's */
const placeOf = (o: Group, to: Group): string => (o.rep.oEnd.book.key === to.rep.oEnd.book.key ? `שורה ${o.rep.oEnd.line + 1}` : `${o.rep.oEnd.book.title}, שורה ${o.rep.oEnd.line + 1}`);

function finalize(g: Group, stats: MergeStats, opts: MergeOptions, suspect: { conflicts: number; support: number } | null, against: { judged: number; contradicted: number } | null): MergedSuggestion {
  const rep = g.rep.s;
  const reasons: Reason[] = [...rep.reasons];
  const warnings: Reason[] = [...rep.warnings];
  const rules: string[] = [...rep.rules];

  let level = supportLevel(g);
  const evidence: MergeEvidence[] = [];
  const support = agreeing(g);
  if (g.engines.length > 1) {
    stats.agreements++;
    rules.push("maxlink/agree", ...g.engines.map((e) => `maxlink/engine:${e}`));
    reasons.push(r("maxlink/agree", `${g.engines.length} שיטות הגיעו לאותו קישור: ${g.engines.map(engineTitle).join(", ")}.`));
    if (!support && g.exact.filter((x) => rank(x.s.confidence) <= POSSIBLE).length > 1) {
      // one source twice is not two: a ד"ה searched only in the line the heading names
      rules.push("maxlink/agree-dependent");
      reasons.push(r("maxlink/agree-dependent", "דיבור המתחיל חיפש רק בתוך השורה הממוספרת שהכותרת בפירוש מציינת, ולכן ההסכמה עם שיטת הכותרות אינה ראיה שנייה, והוודאות לא עלתה."));
    }
  }
  for (const x of g.exact) evidence.push({ engine: x.s.engine, role: x === g.rep ? "representative" : "agrees", confidence: x.s.confidence, basis: basisOf(x.s), width: widthOf(x.oSpan), counted: x === g.rep || !!support?.includes(x) });
  const own = rank(rep.confidence);
  const alternatives: Candidate[] = [];
  const seenAlt = new Set<string>([endKey(g.rep.oEnd)]);
  if (g.consistent.length) {
    stats.consistent++;
    const ce = [...new Set(g.consistent.map((x) => x.s.engine))].sort((a, b) => engineRank(a) - engineRank(b));
    const names = `${ce.length > 1 ? "השיטות" : "השיטה"} ${ce.map(engineTitle).join(", ")}`;
    const widest = Math.max(...g.consistent.map((x) => widthOf(x.oSpan)));
    const confirming = g.consistent.filter((x) => confirms(g, x));
    const raisedBy = ownLevel(g) === POSSIBLE && !support && confirming.length > 0;
    rules.push("maxlink/consistent");
    const how = g.exact.some((x) => basisOf(x.s) === "words-whole-book") ? "דיבור המתחיל חיפש את המילים בכל ספר הבסיס ומצא אותן בתוך הטווח הזה" : "המקום המדויק נמצא בלי להיעזר בטווח הזה";
    reasons.push(r("maxlink/consistent", `גם ${names} ${ce.length > 1 ? "מצביעות" : "מצביעה"} על המקום הזה, בטווח רחב יותר שמכיל אותו (עד ${widest} שורות).${raisedBy ? ` ${how}, ולכן אלה שתי ראיות בלתי תלויות, והוודאות עלתה ל"גבוהה" (לא יותר: טווח אינו מאשר שורה אחת).` : ""}`));
    if (raisedBy) {
      // the reason above says why it rose
    } else if (g.consistent.every((x) => !g.exact.some((e) => independentOf(e, x)))) {
      rules.push("maxlink/contains-dependent");
      reasons.push(r("maxlink/contains-dependent", `המקום המדויק נמצא בחיפוש בתוך הקטע שהכותרות של הפירוש קובעות (או שהוא יורש את המקום של השורה הקודמת), ולכן העובדה שהוא בתוך הטווח של ${names} אינה ראיה נוספת, והוודאות לא עלתה. הטווח מוצג כמועמד חלופי.`));
    } else if (g.consistent.some((x) => widthOf(x.oSpan) > CONTAINMENT_MAX_WIDTH)) {
      rules.push("maxlink/contains-wide");
      reasons.push(r("maxlink/contains-wide", `הטווח של ${names} רחב (${widest} שורות, יותר מ־${CONTAINMENT_MAX_WIDTH}), ולכן העובדה שהמקום בתוכו אינה מחזקת את ההצעה. הטווח מוצג כמועמד חלופי.`));
    }
    for (const x of [...g.consistent].sort(better)) {
      evidence.push({ engine: x.s.engine, role: "containing", confidence: x.s.confidence, basis: basisOf(x.s), width: widthOf(x.oSpan), counted: raisedBy && confirming.includes(x) });
      const k = endKey(x.oSpan);
      if (seenAlt.has(k)) continue;
      seenAlt.add(k);
      alternatives.push({ target: x.oEnd, score: x.s.score, reasons: [r("maxlink/coarse", `הטווח שהציעה ${engineTitle(x.s.engine)} (שורות ${x.oSpan.line + 1}–${endOf(x.oSpan) + 1}), שמכיל את המקום הזה.`)] });
    }
  }
  if (g.inner.length) {
    const ie = [...new Set(g.inner.map((x) => x.s.engine))].sort((a, b) => engineRank(a) - engineRank(b));
    rules.push("maxlink/inner");
    reasons.push(r("maxlink/inner", `${ie.map(engineTitle).join(", ")} ${ie.length > 1 ? "הציעו" : "הציעה"} מקום מדויק בתוך הטווח הזה, אבל בלי ודאות; הוא מוצג כמועמד חלופי.`));
    for (const x of [...g.inner].sort(better)) {
      evidence.push({ engine: x.s.engine, role: "inner", confidence: x.s.confidence, basis: basisOf(x.s), width: widthOf(x.oSpan), counted: false });
      const k = endKey(x.oEnd);
      if (seenAlt.has(k)) continue;
      seenAlt.add(k);
      alternatives.push({ target: x.oEnd, score: x.s.score, reasons: [r("maxlink/inner", `הצעה של ${engineTitle(x.s.engine)} (${CONFIDENCE_LABELS[x.s.confidence]}).`)] });
    }
  }
  if (suspect && g.engines.length < 2 && !g.consistent.length && level < POSSIBLE) {
    level = POSSIBLE;
    rules.push("maxlink/pair-disagree");
    warnings.push(r("maxlink/pair-disagree", `בין שני הספרים האלה השיטות סותרות זו את זו ב־${suspect.conflicts} מקומות, ומסכימות רק ב־${suspect.support}. ייתכן שהמבנה של אחד הספרים (למשל מספור דפים משלו) אינו של ספר הבסיס, ולכן הצעה של שיטה אחת כאן היא לבדיקה בלבד.`));
  }
  if (against && level < POSSIBLE) {
    level = POSSIBLE;
    rules.push("maxlink/contradicts-library");
    warnings.push(r("maxlink/contradicts-library", `הספרייה כבר מקשרת ${against.judged} שורות בין שני הספרים האלה, וההצעות כאן מצביעות על מקום אחר ב־${against.contradicted} מהן. כנראה שהמבנה של הספר (למשל מספור דפים משלו) אינו של ספר הבסיס, ולכן אף הצעה כאן אינה "ודאית".`));
  }
  if (g.outweighs.length) {
    // a won conflict costs one step and never lifts the winner: certain → high, high → possible
    stats.settled++;
    const others = [...g.outweighs].sort((a, b) => cmp(a.id, b.id));
    stats.outweighed += others.length;
    const why =
      g.wonBy === "candidates"
        ? "ההצעה הזו בטוחה יותר מההצעות לספרים האחרים שבחרתם"
        : g.wonBy === "certain"
          ? "ההצעה הזו ודאית, והאחרות אינן"
          : "ההצעה הזו נמצאה לפי המילים של השורה (ציטוט מהבסיס), והאחרות רק לפי הכותרות או המספור, שמתבלבלים במקרים כאלה הרבה יותר";
    if (level < POSSIBLE) level = level === 0 ? rank("high") : POSSIBLE;
    rules.push(g.wonBy === "candidates" ? "maxlink/multi-target-winner" : "maxlink/outweighs");
    warnings.push(r(g.wonBy === "candidates" ? "maxlink/multi-target-winner" : "maxlink/outweighs", `${g.wonBy === "candidates" ? "השורה הזו מתאימה גם לספרים אחרים שבחרתם" : "שיטות אחרות הציעו לשורה הזו יעדים אחרים"}: ${others.map((o) => `${o.engines.map(engineTitle).join(", ")} ← ${placeOf(o, g)}`).join("; ")}. ${why}, ולכן היא נבחרה. בגלל הסתירה היא לבדיקה ולא לאישור בקבוצה, והיעדים האחרים מוצגים כמועמדים חלופיים.`));
    for (const o of others) {
      for (const x of o.exact) evidence.push({ engine: x.s.engine, role: "outweighed", confidence: x.s.confidence, basis: basisOf(x.s), width: widthOf(x.oSpan), counted: false });
      seenAlt.add(endKey(o.rep.oEnd));
      alternatives.push({ target: o.rep.oEnd, score: o.rep.s.score, reasons: [r("maxlink/outweighed", `הצעה של ${o.engines.map(engineTitle).join(", ")} (${placeOf(o, g)}), שנדחתה מפני ההצעה הזו: ${why}.`)] });
    }
  } else if (g.conflictWith.length) {
    stats.conflicts++;
    rules.push("maxlink/conflict");
    const others = [...g.conflictWith].sort((a, b) => cmp(a.id, b.id));
    warnings.push(r("maxlink/conflict", `שיטות שונות הציעו לשורה הזו יעדים שונים: ${others.map((o) => `${o.engines.map(engineTitle).join(", ")} ← שורה ${o.rep.oEnd.line + 1}`).join("; ")}. בדקו ובחרו.`));
    if (level < AMBIGUOUS) level = AMBIGUOUS;
    for (const o of others) {
      seenAlt.add(endKey(o.rep.oEnd));
      alternatives.push({ target: o.rep.oEnd, score: o.rep.s.score, reasons: [r("maxlink/alternative", `הצעה של ${o.engines.map(engineTitle).join(", ")}.`)] });
    }
  }
  if (g.multi.length) {
    // equally sure suggestions to several of the books the user chose: none is picked for them
    if (!g.conflictWith.length) stats.conflicts++;
    rules.push("maxlink/multi-target");
    warnings.push(r("maxlink/multi-target", `השורה הזו מתאימה באותה מידה לכמה מהספרים שבחרתם: ${g.multi.map((o) => placeOf(o, g)).join("; ")}. לא נבחר ביניהם: בדקו ובחרו.`));
    if (level < AMBIGUOUS) level = AMBIGUOUS;
    for (const o of g.multi) {
      seenAlt.add(endKey(o.rep.oEnd));
      alternatives.push({ target: o.rep.oEnd, score: o.rep.s.score, reasons: [r("maxlink/multi-target", `הצעה של ${o.engines.map(engineTitle).join(", ")} ל${o.rep.oEnd.book.title} (שורה ${o.rep.oEnd.line + 1}).`)] });
    }
  }
  for (const x of g.exact)
    for (const a of x.s.alternatives) {
      const k = endKey(a.target);
      if (seenAlt.has(k)) continue;
      seenAlt.add(k);
      alternatives.push(a);
    }
  alternatives.sort((a, b) => b.score - a.score || cmp(endKey(a.target), endKey(b.target)));

  // a structural link that writes only the first line of the span it stands for is never "certain" (capSpanned)
  if (level < rank("high") && rep.citedSpan && !isSingleBook(rep.engine)) {
    const capped = capSpanned("certain", rep.citedSpan);
    level = rank("high");
    if (!warnings.some((w) => w.code === capped.warning!.code)) warnings.push(capped.warning!);
  }
  if (level < own) {
    stats.raised++;
    rules.push("maxlink/raised");
  }
  const confidence = CONFIDENCE_ORDER[level]!;
  const score = Math.max(...g.exact.map((x) => x.s.score));
  // a raw suggestion can reach a group by more than one path (containment is transitive): list it once
  const seen = new Set<string>();
  const lost = g.outweighs.flatMap((o) => [...o.exact, ...o.consistent, ...o.inner]);
  const members: MergeItem[] = [...g.exact, ...g.consistent, ...g.inner, ...lost].filter((x) => !seen.has(x.s.id) && seen.add(x.s.id)).map((x) => ({ suggestion: x.s, focus: x.focus }));
  const matched = matchedOf(g);
  const merged: MergedSuggestion = { ...rep, ...(matched && { matched }), id: g.id, confidence, score, reasons, warnings, rules, alternatives, engines: g.engines, members, focus: g.rep.focus, evidence };
  const where = opts.existing?.(merged) ?? null;
  if (!where) return merged;
  stats.existing++;
  return {
    ...merged,
    rules: [...rules, `maxlink/exists-${where}`],
    reasons: [...reasons, r(`maxlink/exists-${where}`, where === "db" ? "הקישור כבר קיים במסד שממנו נפתח הספר." : "הקישור כבר קיים בפרויקט.")],
  };
}

/**
 * A pair's own confidence threshold (UserPair.minConfidence, plan.ts): the suggestions of that pair below it are not shown. The
 * pair is the focus book (the commentary, the main book) against the other end, by title, as PlanChoices keys it
 * (`<dependant>><base>`); a pair with no threshold is untouched. Returns what stays and how many were hidden.
 */
export function applyPairMinimums(list: readonly MergedSuggestion[], minimums: Readonly<Record<string, Confidence>>): { kept: MergedSuggestion[]; hidden: number } {
  if (!Object.keys(minimums).length) return { kept: [...list], hidden: 0 };
  const kept: MergedSuggestion[] = [];
  for (const s of list) {
    const mine = s.source.book.key === s.focus ? s.source : s.target;
    const other = mine === s.source ? s.target : s.source;
    const min = minimums[`${mine.book.title}>${other.book.title}`];
    if (min === undefined || rank(s.confidence) <= rank(min)) kept.push(s);
  }
  return { kept, hidden: list.length - kept.length };
}