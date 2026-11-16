import type { Reason } from "../types";
import type { Alignment } from "./align";
import { kindWord, type PathElement } from "./numbering";
import { pathKey, type BookStructure, type Unit } from "./structure";

/*
 * Structural-consistency guards of the headings engine. The aligner (./align.ts) judges ONE path at a
 * time, so a pair whose heading trees only LOOK alike gets confident links: the same kind word and
 * the same numbers, but the numbers do not mean the same thing in the two books. Measured on 32
 * commentary–base pairs of the real database (docs/validation/REAL_DATA_REPORT.md §7):
 *
 *   • "הגהות מנחם ציון" numbers its OWN notes "סעיף א, ב, ג…" in each מערכת, while the base numbers
 *     its entries; every number exists in the base, so each line got a "high" link — 20/615 right.
 *     Signature: in section after section the commentary's numbers run 1..k WITHOUT GAPS while the
 *     base's run on to m ≫ k. A real commentary that skips is gappy; a complete one reaches m.
 *   • "ראב"ד על ספרא" counts paragraphs "פסקה א…יז"; the base's "(א)…(ח)" lines in the same section
 *     are the 13 middot, an unrelated count. The commentary level was mapped onto the base's bare
 *     numbers (an "inline-number" step) and every link was "certain" — 0/27 right. Signature: most
 *     of the commentary's numbers do not exist among the base's numbers under the same parent.
 *   • "הערות שוליים על מכילתא דרשב"י": "פרק ג › פסוק א" matched "הוספה › פרק ג › (א)" fully (skipping
 *     the base's named "הוספה" level) although "פרק ג" itself is the base's main פרק ג — a line was
 *     placed outside the place of its own section. See `insideParent`.
 *
 *   • "שפתי כהן על שולחן ערוך חושן משפט" heads its notes "סעיף טו" where טו is its OWN ס"ק: the note on
 *     the שולחן ערוך's סעיף יד. The numbers are dense and mostly exist in the base, so neither guard above
 *     fires, and each line went to the wrong סעיף (2,334 of 5,456 against the database's links).
 *     Signature: the commentary names a number the section does not have — its highest number is above
 *     the base's highest — in section after section (197 of 386 סימנים there; 4 of 665 in "ביאור הגר"א",
 *     which counts the base's סעיפים). Such a level is not a place at all: the line is linked to the
 *     section above it ("beyond-base"; index.ts drops the level from the line's path).
 *
 * The numbering guards are PAIR-level statistics over a commentary level (a kind), so they work for
 * a single-engine run and do not depend on the max-link merge (whose PAIR_DISAGREEMENT compares
 * engines). They only lower confidence; they never invent a different target.
 */

/** a level is "own numbering" when, over its sections, numbers are this dense… */
const DENSE_MIN = 0.9;
/** …and reach at most this share of the base's numbers */
const REACH_MAX = 0.7;
/** a level whose numbers exist in the base below this share is not the base's numbering */
const SHARED_MIN = 0.8;
/** the dense-prefix pattern must repeat in this many sections (one short commentary section proves nothing) */
const MIN_SECTIONS = 3;
/** numbers needed before a level is judged at all */
const MIN_NUMBERS = 10;
/** "beyond-base": sections whose highest number is above the base's highest… */
const BEYOND_MIN_SECTIONS = 3;
/** …and their share of the sections compared */
const BEYOND_MIN_SHARE = 0.1;

export interface LevelStats {
  readonly kind: string;
  /** sections (commentary parent paths) whose parent was found in the base with children to compare */
  readonly sections: number;
  /** commentary numbers judged */
  readonly numbers: number;
  /** share of them that exist among the base's numbers under the same parent */
  readonly shared: number;
  /** Σ count / Σ max: 1 = every section numbered 1..k without gaps */
  readonly dense: number;
  /** Σ commentary max / Σ base max */
  readonly reach: number;
  /** sections whose highest commentary number is above the base's highest there */
  readonly beyond: number;
  readonly verdict: "parallel" | "own-numbering" | "not-shared" | "beyond-base";
}

export interface NumberingVerdict {
  /** commentary kinds whose numbers are not the base's numbers */
  readonly suspect: ReadonlyMap<string, LevelStats>;
  readonly levels: readonly LevelStats[];
}

type Matcher = (P: readonly PathElement[]) => readonly { readonly unit: Unit; readonly score: number; readonly alignment: Alignment }[];

/** Numbered base units by kind ("?" = bare numbers / "(N)" lines), in book order. Daf and names are not numbering. */
function unitsByKind(units: readonly Unit[]): Map<string, Unit[]> {
  const out = new Map<string, Unit[]>();
  for (const u of units) {
    const last = u.path[u.path.length - 1];
    if (!last || last.n === undefined || last.kind === "name" || last.kind === "daf") continue;
    const list = out.get(last.kind);
    if (list) list.push(u);
    else out.set(last.kind, [u]);
  }
  for (const list of out.values()) list.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * The numbers of `kind` the base has INSIDE a unit's range — its shallowest descendants of that kind,
 * not only its direct children: a base may group its סימנים under named headings the commentary does
 * not have ("חלק א › הלכות ציצית › סימן ח" against "חלק א › סימן ח"). Bare numbers stand in for a kind
 * the base does not use there, as in align.ts.
 */
function numbersInside(byKind: ReadonlyMap<string, readonly Unit[]>, parent: Unit, kind: string): Set<number> | undefined {
  const pick = (k: string): Set<number> | undefined => {
    const list = byKind.get(k);
    if (!list) return undefined;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.start < parent.start) lo = mid + 1;
      else hi = mid;
    }
    const inside: Unit[] = [];
    for (let i = lo; i < list.length && list[i]!.start <= parent.end; i++) {
      const u = list[i]!;
      if (u !== parent && u.end <= parent.end && u.path.length > parent.path.length) inside.push(u);
    }
    if (!inside.length) return undefined;
    const depth = Math.min(...inside.map((u) => u.path.length));
    return new Set(inside.filter((u) => u.path.length === depth).map((u) => u.path[u.path.length - 1]!.n!));
  };
  return pick(kind) ?? (kind === "?" ? undefined : pick("?"));
}

/**
 * Compares, level by level, the numbers the commentary's headings use with the numbers the base
 * has under the same section. Daf headings and named headings are not numbering and are left out.
 */
export function assessNumbering(cs: BookStructure, units: readonly Unit[], match: Matcher): NumberingVerdict {
  const byKind = unitsByKind(units);
  // commentary: parent path → kind → numbers
  const groups = new Map<string, { parent: readonly PathElement[]; kind: string; nums: Set<number> }>();
  for (const h of cs.headings) {
    const last = h.path[h.path.length - 1];
    if (!last || last.n === undefined || last.kind === "name" || last.kind === "daf" || h.path.length < 2) continue;
    const parent = h.path.slice(0, -1);
    const k = `${pathKey(parent)}|${last.kind}`;
    const g = groups.get(k) ?? { parent, kind: last.kind, nums: new Set<number>() };
    g.nums.add(last.n);
    groups.set(k, g);
  }
  const acc = new Map<string, { sections: number; numbers: number; shared: number; count: number; cMax: number; bMax: number; beyond: number }>();
  for (const g of groups.values()) {
    // the parent's place in the base, when it is found exactly and unambiguously
    const cands = match(g.parent).filter((c) => c.alignment.missing === 0);
    const top = cands[0];
    if (!top || (cands[1] && cands[1].score === top.score)) continue;
    const base = numbersInside(byKind, top.unit, g.kind);
    if (!base || !base.size) continue;
    const a = acc.get(g.kind) ?? { sections: 0, numbers: 0, shared: 0, count: 0, cMax: 0, bMax: 0, beyond: 0 };
    a.sections++;
    a.numbers += g.nums.size;
    for (const n of g.nums) if (base.has(n)) a.shared++;
    a.count += g.nums.size;
    a.cMax += Math.max(...g.nums);
    a.bMax += Math.max(...base);
    if (Math.max(...g.nums) > Math.max(...base)) a.beyond++;
    acc.set(g.kind, a);
  }
  const levels: LevelStats[] = [];
  const suspect = new Map<string, LevelStats>();
  for (const [kind, a] of acc) {
    const shared = a.shared / a.numbers;
    const dense = a.count / a.cMax;
    const reach = a.cMax / a.bMax;
    let verdict: LevelStats["verdict"] = "parallel";
    if (a.numbers >= MIN_NUMBERS) {
      if (a.beyond >= BEYOND_MIN_SECTIONS && a.beyond >= BEYOND_MIN_SHARE * a.sections) verdict = "beyond-base";
      else if (shared < SHARED_MIN) verdict = "not-shared";
      else if (a.sections >= MIN_SECTIONS && dense >= DENSE_MIN && reach <= REACH_MAX) verdict = "own-numbering";
    }
    const s: LevelStats = { kind, sections: a.sections, numbers: a.numbers, shared, dense, reach, beyond: a.beyond, verdict };
    levels.push(s);
    if (verdict !== "parallel") suspect.set(kind, s);
  }
  return { suspect, levels };
}

/** The commentary element that landed on the target's own (deepest) heading. */
export function targetElement(a: Alignment): PathElement | undefined {
  for (let i = a.events.length - 1; i >= 0; i--) {
    const e = a.events[i]!;
    if (e.code !== "skip-commentary" && e.code !== "skip-base" && e.code !== "missing") return e.c;
  }
  return undefined;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const levelName = (kind: string) => (kind === "?" ? "המספור בלי שם" : `"${kindWord(kind) || kind}"`);

export function numberingNote(s: LevelStats): Reason {
  if (s.verdict === "beyond-base")
    return {
      code: "heading/beyond-base",
      text: `${levelName(s.kind)} בפירוש הוא מספור משלו ולא של ספר הבסיס: ב־${s.beyond} מתוך ${s.sections} קטעים הפירוש מגיע למספר שאין בבסיס באותו קטע. לכן שורה תחת הרמה הזו מקושרת לקטע שמעליה כולו, ו"אפשרית" בלבד`,
    };
  return s.verdict === "own-numbering"
    ? {
        code: "heading/own-numbering",
        text: `המספור של ${levelName(s.kind)} בפירוש נראה כמספור עצמי של הפירוש ולא כמספור של ספר הבסיס: ב־${s.sections} קטעים המספרים רצופים מ־1 (${pct(s.dense)}) ומגיעים רק ל־${pct(s.reach)} מהמספרים שבבסיס. קישורים לפי הרמה הזו סומנו "אפשרית" בלבד`,
      }
    : {
        code: "heading/numbering-not-shared",
        text: `רק ${pct(s.shared)} מהמספרים של ${levelName(s.kind)} בפירוש קיימים בספר הבסיס באותו קטע, ולכן המספור כנראה אינו אותו מספור. קישורים לפי הרמה הזו סומנו "אפשרית" בלבד`,
      };
}

export function numberingWarning(s: LevelStats): Reason {
  return {
    code: s.verdict === "beyond-base" ? "heading/beyond-base" : s.verdict === "own-numbering" ? "heading/own-numbering" : "heading/numbering-not-shared",
    text:
      s.verdict === "beyond-base"
        ? `${levelName(s.kind)} בפירוש אינו המספור של ספר הבסיס (ראו הערות הריצה), ולכן השורה מקושרת לקטע שמעליו כולו, והביטחון הוגבל ל"אפשרית"`
        : `ייתכן ש${levelName(s.kind)} בפירוש אינו המספור של ספר הבסיס (ראו הערות הריצה), ולכן הביטחון הוגבל ל"אפשרית"`,
  };
}
