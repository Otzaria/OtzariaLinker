import type { LinkSide, RawAnchor } from "../core/links/model";
import { CONFIDENCE_ORDER, ENGINES, type Candidate, type Confidence, type EngineId, type Reason, type Suggestion } from "./automatic";

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
 *     from different engines are a CONFLICT: every side drops to "ambiguous", with the others as
 *     alternatives. Ambiguous suggestions are never approved in bulk.
 * Only "certain" is approved in bulk (store.pendingAtLeast("certain")); nothing here changes that.
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
}

export type ExistingWhere = "db" | "project";

export interface MergeOptions {
  /** where the link already exists, judged on the FINAL suggestion (its id included), or null */
  existing?: (s: Suggestion) => ExistingWhere | null;
  /**
   * linePairKey of links the library already has (the database's links of the books read). A book
   * pair whose suggestions mostly CONTRADICT them is suspect (REFERENCE_DISAGREEMENT).
   */
  reference?: Iterable<string>;
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
  /** outputs lowered to "ambiguous" by a conflict */
  conflicts: number;
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
  const a = `${l.source.book.key}#${l.source.line}`;
  const b = `${l.target.book.key}#${l.target.line}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
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
  fAnchor: RawAnchor | undefined;
}

function toRaw(it: MergeItem): Raw {
  const s = it.suggestion;
  const focusIsTarget = s.target.book.key === it.focus && s.source.book.key !== it.focus;
  return { s, focus: it.focus, fEnd: focusIsTarget ? s.target : s.source, oEnd: focusIsTarget ? s.source : s.target, fAnchor: focusIsTarget ? undefined : s.anchor };
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
}

const better = (a: Raw, b: Raw) =>
  rank(a.s.confidence) - rank(b.s.confidence) || repRank(a.s.engine) - repRank(b.s.engine) || b.s.score - a.s.score || cmp(a.s.id, b.s.id);

function makeGroup(id: string, exact: Raw[]): Group {
  const rep = [...exact].sort(better)[0]!;
  const engines = [...new Set(exact.map((r) => r.s.engine))].sort((a, b) => engineRank(a) - engineRank(b));
  const position = `${endKey(rep.fEnd)}${rep.fAnchor ? `@${rep.fAnchor.rawStart}` : ""}>${rep.oEnd.book.key}`;
  return { id, exact, rep, engines, position, consistent: [], inner: [], folded: false, conflictWith: [] };
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
const bookPair = (g: Group) => `${g.rep.fEnd.book.key}>${g.rep.oEnd.book.key}`;

/** at least one member is "possible" or better: ambiguous and "none" give no support */
const strong = (g: Group) => g.exact.some((x) => rank(x.s.confidence) <= POSSIBLE);

/** a's other end strictly contains b's (same book is implied by the shared position) */
const contains = (a: Group, b: Group) => {
  const [x, y] = [a.rep.oEnd, b.rep.oEnd];
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
    const a = endKey(r.s.source);
    const b = endKey(r.s.target);
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    const list = byPair.get(k);
    if (list) list.push(r);
    else byPair.set(k, [r]);
  }
  const groups: Group[] = [];
  for (const k of [...byPair.keys()].sort()) {
    const list = byPair.get(k)!;
    const perEngine = new Map<string, Raw[]>();
    for (const r of list) perEngine.set(r.s.engine, [...(perEngine.get(r.s.engine) ?? []), r]);
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
  for (const g of groups) byPos.set(g.position, [...(byPos.get(g.position) ?? []), g]);
  for (const at of byPos.values()) {
    if (at.length < 2) continue;
    // a precise suggestion with support absorbs the coarse range around it…
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
          a.inner.push(...b.exact);
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
    const live = at.filter((g) => !g.folded);
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
  const versus = new Map<string, { judged: number; contradicted: number }>();
  if (refLines.size)
    for (const g of groups) {
      if (g.folded) continue;
      const known = refLines.get(`${g.rep.fEnd.book.key}#${g.rep.fEnd.line}>${g.rep.oEnd.book.key}`);
      if (!known) continue;
      const v = versus.get(bookPair(g)) ?? { judged: 0, contradicted: 0 };
      v.judged++;
      if (!known.some((l) => l >= g.rep.oEnd.line && l <= endOf(g.rep.oEnd))) v.contradicted++;
      versus.set(bookPair(g), v);
    }
  const contradicted = new Map([...versus].filter(([, v]) => v.judged >= REFERENCE_DISAGREEMENT.minJudged && v.contradicted / v.judged >= REFERENCE_DISAGREEMENT.ratio));

  // 5. one suggestion per live group
  const stats: MergeStats = { input: raws.length, output: 0, duplicates: 0, agreements: 0, raised: 0, consistent: 0, conflicts: 0, existing: 0, suspectPairs: suspect.size, contradictedPairs: contradicted.size };
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

function finalize(g: Group, stats: MergeStats, opts: MergeOptions, suspect: { conflicts: number; support: number } | null, against: { judged: number; contradicted: number } | null): MergedSuggestion {
  const rep = g.rep.s;
  const reasons: Reason[] = [...rep.reasons];
  const warnings: Reason[] = [...rep.warnings];
  const rules: string[] = [...rep.rules];

  let level = Math.min(...g.exact.map((x) => rank(x.s.confidence)));
  const support = g.exact.filter((x) => rank(x.s.confidence) <= POSSIBLE);
  const supportEngines = new Set(support.map((x) => x.s.engine));
  if (g.engines.length > 1) {
    stats.agreements++;
    rules.push("maxlink/agree", ...g.engines.map((e) => `maxlink/engine:${e}`));
    reasons.push(r("maxlink/agree", `${g.engines.length} שיטות הגיעו לאותו קישור: ${g.engines.map(engineTitle).join(", ")}.`));
  }
  const own = rank(rep.confidence);
  if (supportEngines.size > 1) level = Math.max(0, Math.min(...support.map((x) => rank(x.s.confidence))) - 1);
  if (g.consistent.length) {
    stats.consistent++;
    const ce = [...new Set(g.consistent.map((x) => x.s.engine))].sort((a, b) => engineRank(a) - engineRank(b));
    rules.push("maxlink/consistent");
    reasons.push(r("maxlink/consistent", `גם ${ce.length > 1 ? "השיטות" : "השיטה"} ${ce.map(engineTitle).join(", ")} ${ce.length > 1 ? "מצביעות" : "מצביעה"} על המקום הזה, בטווח רחב יותר שמכיל אותו.`));
    if (level === POSSIBLE && g.consistent.some((x) => rank(x.s.confidence) <= rank("high"))) level = rank("high");
  }
  const alternatives: Candidate[] = [];
  const seenAlt = new Set<string>([endKey(g.rep.oEnd)]);
  if (g.inner.length) {
    const ie = [...new Set(g.inner.map((x) => x.s.engine))].sort((a, b) => engineRank(a) - engineRank(b));
    rules.push("maxlink/inner");
    reasons.push(r("maxlink/inner", `${ie.map(engineTitle).join(", ")} ${ie.length > 1 ? "הציעו" : "הציעה"} מקום מדויק בתוך הטווח הזה, אבל בלי ודאות; הוא מוצג כמועמד חלופי.`));
    for (const x of [...g.inner].sort(better)) {
      const k = endKey(x.oEnd);
      if (seenAlt.has(k)) continue;
      seenAlt.add(k);
      alternatives.push({ target: x.oEnd, score: x.s.score, reasons: [r("maxlink/inner", `הצעה של ${engineTitle(x.s.engine)}.`)] });
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
  if (g.conflictWith.length) {
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
  for (const x of g.exact)
    for (const a of x.s.alternatives) {
      const k = endKey(a.target);
      if (seenAlt.has(k)) continue;
      seenAlt.add(k);
      alternatives.push(a);
    }
  alternatives.sort((a, b) => b.score - a.score || cmp(endKey(a.target), endKey(b.target)));

  if (level < own) {
    stats.raised++;
    rules.push("maxlink/raised");
  }
  const confidence = CONFIDENCE_ORDER[level]!;
  const score = Math.max(...g.exact.map((x) => x.s.score));
  const members: MergeItem[] = [...g.exact, ...g.consistent, ...g.inner].map((x) => ({ suggestion: x.s, focus: x.focus }));
  const merged: MergedSuggestion = { ...rep, id: g.id, confidence, score, reasons, warnings, rules, alternatives, engines: g.engines, members, focus: g.rep.focus };
  const where = opts.existing?.(merged) ?? null;
  if (!where) return merged;
  stats.existing++;
  return {
    ...merged,
    rules: [...rules, `maxlink/exists-${where}`],
    reasons: [...reasons, r(`maxlink/exists-${where}`, where === "db" ? "הקישור כבר קיים במסד שממנו נפתח הספר." : "הקישור כבר קיים בפרויקט.")],
  };
}
