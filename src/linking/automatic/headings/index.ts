import type { LinkSide } from "../../../core/links/model";
import { toGematria } from "../../../core/text/gematria";
import {
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
import { dafElement, kindThe, kindWord, type NumberingMode, type PathElement } from "./numbering";
import { analyzeBook, buildUnits, pathKey, type BookStructure, type Unit } from "./structure";

/*
 * The HEADINGS engine (plan stage 8.1): every commentary line inherits its structural position from
 * the headings above it (פרק › פסוק, סימן › סעיף, דף › עמוד, הלכות › הלכה, משנה…), the base book gets
 * the same tree, and each commentary content line is linked to the base line — or line range — at
 * the deepest level that matches. Pure and synchronous; see ./align.ts for the matching rules and
 * ./numbering.ts for how headings are read.
 */

export type { NumberingMode } from "./numbering";

export interface HeadingsOptions {
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
}

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
}

export function runHeadingsEngine(commentary: EngineBook, base: EngineBook, options: HeadingsOptions = {}, ctx: EngineContext = {}): EngineResult {
  const opts = {
    // "source": the record sits in the commentary's file and the generator stores it base → commentary,
    // which is how the app shows a commentary (compatibility review #1). "commentary" would be stored backwards.
    declaredType: options.declaredType ?? "source",
    numbering: options.numbering ?? "lenient",
    inlineMarkers: options.inlineMarkers ?? "auto",
    untaggedHeadings: options.untaggedHeadings ?? true,
    thresholds: options.thresholds ?? DEFAULT_THRESHOLDS,
    maxAlternatives: options.maxAlternatives ?? 3,
  };
  const notes: Reason[] = [];
  const suggestions: Suggestion[] = [];
  const unmatched: { line: number; reasons: Reason[] }[] = [];
  const aborted = () => ctx.signal?.aborted === true;
  const done = (): EngineResult => ({ suggestions, notes, unmatched });

  const cs = analyzeBook(commentary, opts);
  const bs = analyzeBook(base, opts);
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

  // inline markers on commentary lines
  const useMarkers = decideMarkers(cs, bs, units, opts.inlineMarkers, match, notes);
  structuralNotes(cs, bs, units, notes);

  const total = commentary.lines.length;
  let skipped = 0;
  let partial = 0;
  let prevStart: number | null = null;
  for (let p = 0; p < total; p++) {
    if (aborted()) return abortedResult(notes, done);
    if (p % PROGRESS_EVERY === 0) ctx.progress?.(p, total);
    const info = cs.lines[p]!;
    const srcIndex = commentary.lines[p]!.index;
    if (info.skip) { skipped++; continue; }
    const P = useMarkers && info.marker !== null ? [...info.path, { kind: "?", n: info.marker, label: `(${toGematria(info.marker)})` }] : info.path;
    if (!P.length) {
      unmatched.push({ line: srcIndex, reasons: [{ code: "heading/no-position", text: "השורה אינה נמצאת תחת אף כותרת, ולכן אין לה מיקום מבני" }] });
      continue;
    }
    const cands = match(P);
    const best0 = cands[0];
    if (!best0) {
      unmatched.push({ line: srcIndex, reasons: [{ code: "heading/not-found", text: `בספר הבסיס לא נמצא מקום המתאים ל־${describe(P)}` }] });
      continue;
    }
    // ambiguity, and a tie broken by the order of the book
    const margin = opts.thresholds.ambiguityMargin;
    const tied = cands.filter((c) => best0.score - c.score < margin);
    let chosen = best0;
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
    const score = orderTie ? Math.min(chosen.score, ORDER_CAP) : chosen.score;
    const confidence: Confidence = confidenceOf(score, runnerUp, opts.thresholds);
    const { reasons, warnings, rules } = explain(chosen, base);
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
    const target = sideOf(base, chosen.start, chosen.end);
    const source: LinkSide = { book: commentary.book, line: srcIndex };
    suggestions.push({
      id: suggestionId(commentary, srcIndex, target),
      engine: ENGINE,
      source,
      target,
      declaredType: opts.declaredType,
      heRef2: heRefOf(base, chosen),
      score: round(score),
      confidence,
      reasons,
      rules,
      alternatives: cands
        .filter((c) => c !== chosen)
        .slice(0, opts.maxAlternatives)
        .map((c): Candidate => ({ target: sideOf(base, c.start, c.end), score: round(c.score), reasons: explain(c, base).reasons })),
      warnings,
    });
  }
  ctx.progress?.(total, total);
  if (skipped) notes.push({ code: "heading/skipped-lines", text: `${skipped} שורות בפירוש דולגו: כותרות, שורות ריקות או שורות עם פחות משתי אותיות עבריות` });
  if (partial) notes.push({ code: "heading/partial-matches", text: `${partial} שורות קושרו רק לרמה גבוהה יותר (למשל לפרק כולו), כי הרמה העמוקה שלהן לא נמצאה בספר הבסיס` });
  return done();
}

function abortedResult(notes: Reason[], done: () => EngineResult): EngineResult {
  notes.push({ code: "engine/aborted", text: "הריצה הופסקה לבקשת המשתמש; התוצאות חלקיות" });
  return done();
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const round = (x: number) => Math.round(x * 1000) / 1000;

function lastKey(e: PathElement): string {
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

function explain(s: Scored, base: EngineBook): { reasons: Reason[]; warnings: Reason[]; rules: string[] } {
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
  if (s.end > s.start && !s.unit.marker) {
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
