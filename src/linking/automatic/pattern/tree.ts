import type { LinkSide } from "../../../core/links/model";
import { toGematria } from "../../../core/text/gematria";
import { normalize } from "../../../core/text/hebrew";
import { phraseSimilarity } from "../../../matching/similarity";
import type { Candidate, EngineBook, Reason } from "../types";
import { align, COST, type AlignContext, type Alignment } from "../headings/align";
import { kindWord, parseHeading, plainText, type PathElement } from "../headings/numbering";
import { analyzeBook, buildUnits, pathKey, type BookStructure, type Unit } from "../headings/structure";

/*
 * A structure reference ("סימן ה סעיף ג ס"ק ב", "פ"ב מ"ג", "דף ב:") → the place in the TARGET'S
 * heading tree. The target's tree is the headings engine's (headings/structure.ts): tagged headings,
 * untagged heading lines ("סימן ה" alone, "<b>סעיף ג</b>"), and numbered lines ("(ג) …") as the
 * deepest units. The reference path is aligned with every unit's path by the headings engine's
 * aligner (headings/align.ts): kinds and numbers must agree, "(ג)" stands for any kind, a level the
 * reference does not mention ("סעיף ג" under an unnamed סימן) is skipped at a cost, and a level the
 * target lacks makes the match partial (the parent's place, lower score).
 *
 * A reference that leaves out its upper levels ("ס"ק ב" in a commentary arranged by סימן) matches
 * the same unit under every סימן; the SOURCE line's own heading path then decides (its סימן ה picks
 * the target's סימן ה) — the context the commentary's reader has too.
 */

const r = (code: string, text: string): Reason => ({ code, text });

/** a reference with no kind word ("(ג)") is never certain */
const KINDLESS_CAP = 0.9;
/** the N-th content line of a unit, when the target does not number that level at all */
const ORDINAL_SCORE = 0.88;
const MAX_RANGE = 40;
/** a candidate whose skipped levels contradict the source's headings */
const CONTRADICTED = 0.2;
const MAX_ALTERNATIVES = 3;

export interface RefPath {
  readonly elements: readonly PathElement[];
  /** end of a range of the deepest level ("סעיף ג-ה" → 5) */
  readonly to?: number;
}

export type TreePlaced = { readonly target: LinkSide; readonly score: number; readonly reasons: Reason[]; readonly warnings: Reason[]; readonly alternatives: Candidate[]; readonly rules: string[] };
export type TreeUnplaced = { readonly unplaced: Reason };

interface Scored {
  readonly unit: Unit;
  readonly score: number;
  readonly alignment: Alignment;
}

export interface TreeOptions {
  readonly sectionRanges: boolean;
  /** use the source line's heading path to decide between equal candidates. Default true. */
  readonly context: boolean;
}

const pathLabel = (p: readonly PathElement[]): string => p.map((e) => e.label).join(" › ");

export class TargetTree {
  readonly structure: BookStructure;
  private readonly units: Unit[];
  private readonly byKey = new Map<string, Unit[]>();
  /** every heading by its text, for named references: "פרשת נח", "שער הבטחון" */
  private readonly names: { key: string; words: number; elements: readonly PathElement[] }[] = [];
  private readonly numbers = new Set<string>();
  /** units by every element of their path ("siman#5" → every unit under סימן ה) */
  private readonly byElement = new Map<string, Set<Unit>>();

  constructor(private readonly book: EngineBook) {
    this.structure = analyzeBook(book, { numbering: "lenient", untaggedHeadings: true });
    this.units = buildUnits(this.structure);
    for (const u of this.units) {
      const last = u.path[u.path.length - 1]!;
      const k = keyOf(last);
      const list = this.byKey.get(k);
      if (list) list.push(u);
      else this.byKey.set(k, [u]);
      if (last.kind !== "name" && last.kind !== "daf") this.numbers.add(`${last.kind}#${last.n}`);
      for (const e of u.path) {
        const ek = elementKeyOf(e);
        const set = this.byElement.get(ek);
        if (set) set.add(u);
        else this.byElement.set(ek, new Set([u]));
      }
    }
    const seen = new Set<string>();
    for (const h of this.structure.headings) {
      const key = normalize(plainText(book.lines[h.at]!.text));
      if (!key || seen.has(key) || !h.elements.length) continue;
      seen.add(key);
      this.names.push({ key, words: key.split(" ").length, elements: h.elements });
    }
    this.names.sort((a, b) => b.words - a.words || b.key.length - a.key.length);
  }

  /** the heading path of a target line (by line index), for "שם" after a reference */
  pathAt(lineIndex: number): readonly PathElement[] | null {
    const pos = this.book.lines.findIndex((l) => l.index === lineIndex);
    return pos < 0 ? null : (this.structure.lines[pos]?.path ?? null);
  }

  get hasNumberedHeadings(): boolean {
    return this.units.some((u) => !u.marker && u.path.some((e) => e.kind !== "name"));
  }

  /**
   * A named part of a reference ("פרשת נח היא…", "שער הבטחון פרק ג") → the elements of the target's
   * heading with the longest text its words start with (as the tree reads that heading, so the
   * aligner compares like with like), plus the levels written after it. null when there is none.
   */
  resolveName(text: string): PathElement[] | null {
    const words = normalize(text).split(" ").filter(Boolean);
    for (const n of this.names) {
      if (n.words < 2 && !n.elements.some((e) => e.kind === "name")) continue;
      const head = words.slice(0, n.words).join(" ");
      if (head === n.key || (n.words > 1 && phraseSimilarity(head, n.key) >= 0.9)) {
        const rest = words.slice(n.words).join(" ");
        const more = rest ? parseHeading(rest).filter((e) => e.kind !== "name" && e.kind !== "?" && !e.kind.startsWith("w:")) : [];
        return [...n.elements, ...more];
      }
    }
    return null;
  }

  private readonly placed = new Map<string, TreePlaced | TreeUnplaced>();

  /** The place of a reference in the target; `context` = the heading path of the source line. */
  place(ref: RefPath, context: readonly PathElement[], opts: TreeOptions): TreePlaced | TreeUnplaced {
    // only the source's levels the target has can decide anything ("סעיף ב" of a commentary on a ס"ק book cannot)
    const ctx = opts.context ? context.filter((e) => e.kind === "name" || this.structure.kinds.has(e.kind === "amud" ? "daf" : e.kind)) : [];
    // the same reference under the same headings is placed the same way (ס"ק א, ב, ג… in every סימן)
    const key = `${pathKey(ref.elements)}|${ref.to ?? ""}|${pathKey(ctx)}|${opts.sectionRanges}`;
    const hit = this.placed.get(key);
    if (hit) return hit;
    const out = this.placeUncached(ref, ctx, opts);
    this.placed.set(key, out);
    return out;
  }

  private placeUncached(ref: RefPath, context: readonly PathElement[], opts: TreeOptions): TreePlaced | TreeUnplaced {
    const P = ref.elements;
    const ranked = this.match(P);
    const kindless = P.some((e) => e.kind === "?");
    if (!ranked.length) return this.ordinal(P, context, opts) ?? { unplaced: this.why(P) };
    let pool = ranked;
    let ctxNote: Reason | null = null;
    let ctxRule: string | null = null;
    // equal candidates (the reference left out an upper level): the source's own headings decide
    const best = ranked[0]!.score;
    const tied = ranked.filter((s) => best - s.score < 0.02);
    if (tied.length > 1 && opts.context && context.length) {
      // only candidates under one of the source's own levels can agree with it (a fast subset: "ס"ק ב"
      // ties with one unit per סימן, and only the one under the source's סימן matters)
      const near = new Set<Unit>();
      for (const e of context) for (const u of this.byElement.get(elementKeyOf(e)) ?? []) near.add(u);
      const judged = tied.filter((s) => near.has(s.unit)).map((s) => ({ s, ...agreement(s.alignment, context) }));
      const fit = judged.filter((j) => j.conflicts === 0);
      const top = Math.max(0, ...fit.map((j) => j.agrees));
      const winners = fit.filter((j) => j.agrees === top);
      if (top > 0 && winners.length === 1) {
        const w = winners[0]!;
        // the skipped levels the context confirmed cost nothing; candidates it contradicts are far behind
        const s = { ...w.s, score: Math.min(1, w.s.score + COST.skip * w.agrees) };
        // only the few best others matter (alternatives); a reference like "ס"ק ב" ties with one unit per סימן
        const others = [
          ...fit.filter((j) => j !== w).slice(0, MAX_ALTERNATIVES).map((j) => j.s),
          ...ranked.slice(tied.length, tied.length + MAX_ALTERNATIVES),
          ...tied.filter((x) => !near.has(x.unit)).slice(0, MAX_ALTERNATIVES).map((x) => ({ ...x, score: Math.max(0, x.score - CONTRADICTED) })),
          ...judged.filter((j) => j.conflicts > 0).slice(0, MAX_ALTERNATIVES).map((j) => ({ ...j.s, score: Math.max(0, j.s.score - CONTRADICTED) })),
        ].sort((a, b) => b.score - a.score);
        pool = [s, ...others];
        ctxNote = r("pattern/context", `ההפניה לא אומרת את כל הרמות; לפי הכותרות של שורת המקור (${pathLabel(context)}) זה ${pathLabel(w.s.unit.path)}.`);
        ctxRule = "pattern.context";
      }
    }
    const [first, ...rest] = pool as [Scored, ...Scored[]];
    // the target has no unit for the deepest level ("פסוק ג" where verses are plain lines)
    const deepSkipped = first.alignment.events.some((ev) => ev.code === "skip-commentary" && ev.c === P[P.length - 1]);
    if (deepSkipped) {
      const o = this.ordinal(P, context, opts);
      if (o) return o;
    }
    let score = first.score;
    const warnings: Reason[] = [];
    if (deepSkipped) warnings.push(r("pattern/partial", `ביעד אין רמה כמו "${P[P.length - 1]!.label}"; הקישור הולך למקום שמעליה.`));
    if (kindless && score > KINDLESS_CAP) {
      score = KINDLESS_CAP;
      warnings.push(r("pattern/heading-kindless", "ההפניה לא אומרת אם זה סימן, פרק או סעיף; המקום נבחר לפי המספר בלבד."));
    }
    if (first.alignment.missing) warnings.push(r("pattern/partial", `ביעד אין רמה כמו "${P.slice(-first.alignment.missing).map((e) => e.label).join(" › ")}"; הקישור הולך למקום שמעליה.`));
    const target = this.sideOf(first.unit, ref, P, opts, warnings);
    const runnerUps = rest.filter((s) => s.unit !== first.unit).slice(0, 3);
    return {
      target,
      score,
      reasons: [r("pattern/heading", `ביעד: ${pathLabel(first.unit.path)}.`), ...(ctxNote ? [ctxNote] : [])],
      warnings,
      alternatives: runnerUps.map((s) => ({ target: { book: this.book.book, line: this.lineOf(s.unit.start) }, score: s.score, reasons: [r("pattern/heading-other", `גם ${pathLabel(s.unit.path)} מתאים.`)] })),
      rules: [ctxRule ?? (kindless ? "pattern.heading-number" : "pattern.heading-kind"), ...(first.alignment.missing ? ["pattern.partial"] : [])],
    };
  }

  private readonly cache = new Map<string, Scored[]>();

  /** every unit the path aligns with, best first (cached: the same references repeat all over a book) */
  private match(P: readonly PathElement[]): Scored[] {
    if (!P.length) return [];
    const key = pathKey(P);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const out = this.matchUncached(P);
    this.cache.set(key, out);
    return out;
  }

  private matchUncached(P: readonly PathElement[]): Scored[] {
    const kinds = new Set(P.filter((e) => e.kind !== "name" && e.kind !== "?").map((e) => (e.kind === "amud" ? "daf" : e.kind)));
    const actx: AlignContext = {
      baseKinds: this.structure.kinds,
      baseHasNamed: this.structure.hasNamed,
      baseHasUnnamed: this.structure.markerLines > 0 || this.structure.headings.some((h) => h.elements.some((e) => e.kind === "?")),
      commentaryKinds: kinds,
      commentaryHasNamed: P.some((e) => e.kind === "name"),
    };
    const seen = new Set<Unit>();
    const out: Scored[] = [];
    for (const e of P)
      for (const u of this.byKey.get(keyOf(e)) ?? []) {
        if (seen.has(u)) continue;
        seen.add(u);
        const a = align(P, u.path, actx);
        if (!a) continue;
        out.push({ unit: u, score: Math.max(0, 1 - a.penalty), alignment: a });
      }
    // "דף ה" without an amud matched both sides: the first side stands for the daf
    const dafBoth = (s: Scored) => s.alignment.events.some((ev) => ev.code === "daf-both-amudim");
    const kept = out.filter((s) => {
      if (!dafBoth(s)) return true;
      const last = s.unit.path[s.unit.path.length - 1]!;
      return !out.some((o) => o !== s && dafBoth(o) && o.unit.start < s.unit.start && o.unit.path[o.unit.path.length - 1]!.n === last.n);
    });
    return kept.sort((a, b) => b.score - a.score || a.alignment.missing - b.alignment.missing || a.unit.start - b.unit.start);
  }

  /** The target side: the unit's first line; with a range, through the end unit or the whole section. */
  private sideOf(u: Unit, ref: RefPath, P: readonly PathElement[], opts: TreeOptions, warnings: Reason[]): LinkSide {
    const line = this.lineOf(u.start);
    let end = opts.sectionRanges ? u.end : u.start;
    const last = P[P.length - 1];
    if (ref.to !== undefined && last?.n !== undefined && ref.to > last.n && ref.to - last.n <= MAX_RANGE) {
      const endP = [...P.slice(0, -1), { ...last, n: ref.to, label: `${kindWord(last.kind) || ""} ${toGematria(ref.to)}`.trim() }];
      const endUnit = this.match(endP).find((s) => s.unit.start > u.start && s.alignment.missing === 0 && samePrefix(s.unit.path, u.path));
      if (endUnit) end = Math.max(end, endUnit.unit.end);
      else warnings.push(r("pattern/range-end", `סוף הטווח (${toGematria(ref.to)}) לא נמצא ביעד; הקישור הוא לתחילתו בלבד.`));
    }
    const endLine = this.lineOf(end);
    return endLine > line ? { book: this.book.book, line, end: endLine } : { book: this.book.book, line };
  }

  /**
   * The target does not number the deepest level at all (a Tanakh book with a line per verse and no
   * "(א)"): the N-th content line of the parent's place, when the parent resolves cleanly.
   */
  private ordinal(P: readonly PathElement[], context: readonly PathElement[], opts: TreeOptions): TreePlaced | null {
    const last = P[P.length - 1];
    if (P.length < 2 || !last || last.n === undefined || last.kind === "name" || last.kind === "daf") return null;
    if (this.structure.kinds.has(last.kind) || this.structure.markerLines > 0) return null;
    const parent = this.place({ elements: P.slice(0, -1) }, context, { ...opts, sectionRanges: true });
    if ("unplaced" in parent || parent.score < 0.85 || parent.alternatives.length) return null;
    const content: number[] = [];
    for (let i = 0; i < this.book.lines.length; i++) {
      const idx = this.book.lines[i]!.index;
      if (idx < parent.target.line || idx > (parent.target.end ?? parent.target.line)) continue;
      if (this.structure.lines[i]!.skip !== "heading") content.push(idx);
    }
    const line = content[last.n - 1];
    if (line === undefined) return null;
    return {
      target: { book: this.book.book, line },
      score: Math.min(parent.score, ORDINAL_SCORE),
      reasons: [...parent.reasons, r("pattern/ordinal-line", `ביעד אין מספור של ${kindWord(last.kind) || "הרמה הזו"}; זו השורה ה־${last.n} במקום הזה.`)],
      warnings: [r("pattern/ordinal-guess", "המקום נקבע לפי ספירת השורות, בהנחה ששורה אחת היא יחידה אחת.")],
      alternatives: [],
      rules: ["pattern.ordinal-line"],
    };
  }

  private why(P: readonly PathElement[]): Reason {
    const last = P[P.length - 1]!;
    if (last.kind === "name") return r("pattern/no-heading", `ביעד אין כותרת בשם "${last.label}".`);
    if (last.kind !== "?" && last.kind !== "daf" && !this.numbers.has(`${last.kind}#${last.n}`) && [...this.numbers].some((k) => k.endsWith(`#${last.n}`)))
      return r("pattern/heading-kind", `ביעד יש כותרת עם המספר ${last.n}, אבל לא מהסוג "${kindWord(last.kind) || last.label}".`);
    return r("pattern/no-heading", `ביעד אין ${pathLabel(P)}.`);
  }

  private lineOf(pos: number): number {
    return this.book.lines[pos]!.index;
  }
}

/** an element as the context compares it: kind and number (a daf without its side), or a name */
function elementKeyOf(e: PathElement): string {
  if (e.kind === "name") return `$${e.name}`;
  return `${e.kind === "amud" ? "daf" : e.kind}#${e.n}`;
}

function keyOf(e: PathElement): string {
  if (e.kind === "name") return "$";
  if (e.kind === "daf") return `d${e.n}`;
  return `#${e.n}`;
}

function samePrefix(a: readonly PathElement[], b: readonly PathElement[]): boolean {
  const n = Math.min(a.length, b.length) - 1;
  for (let i = 0; i < n; i++) if (a[i]!.label !== b[i]!.label) return false;
  return true;
}

/**
 * How the target levels a reference skipped agree with the source's headings: a skipped "סימן ה"
 * agrees with a source under "סימן ה" and conflicts with one under "סימן ו". Other kinds are not judged.
 */
function agreement(a: Alignment, context: readonly PathElement[]): { agrees: number; conflicts: number } {
  let agrees = 0;
  let conflicts = 0;
  for (const ev of a.events) {
    if (ev.code !== "skip-base" || !ev.b) continue;
    const b = ev.b;
    const same = context.filter((c) => (b.kind === "name" ? c.kind === "name" : c.kind === b.kind));
    if (!same.length) continue;
    const ok = same.some((c) => (b.kind === "name" ? c.name === b.name || phraseSimilarity(c.name!, b.name!) >= 0.85 : c.n === b.n && (b.kind !== "daf" || c.amud === undefined || b.amud === undefined || c.amud === b.amud)));
    if (ok) agrees++;
    else conflicts++;
  }
  return { agrees, conflicts };
}
