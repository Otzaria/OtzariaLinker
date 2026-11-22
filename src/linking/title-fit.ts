import type { EngineBook } from "./automatic/types";
import { align, type AlignContext } from "./automatic/headings/align";
import type { PathElement } from "./automatic/headings/numbering";
import { analyzeBook, buildUnits, pathKey, type Unit } from "./automatic/headings/structure";

/*
 * Title fit: a pre-flight answer to "do these two books have titles that match, so the headings engine is
 * the right method?" (issue #21). The headings engine links a commentary line to the base unit with the
 * same heading path ("פרק ב › פסוק ג"); with no titles, or titles that are not the base's, its guards only
 * LOWER confidence AFTER a run (headings/consistency.ts) and the user has already waited and read a result.
 * This is the same structural reading (analyzeBook / buildUnits) without any matching: pure, linear in the
 * lines, and it explains itself — a verdict plus the reasons, each with the number behind it.
 *
 * It says "fit" / "partial" / "unfit"; it never says "link" or "do not link". The caller offers the method
 * (fit), offers it with a warning (partial) or leaves it to an advanced user who forces it (unfit).
 * A method is not chosen by the number of links it produces (a wrong method produces many wrong links).
 *
 * The metrics are structural only, so they cannot see a commentary that numbers its OWN notes in the base's
 * words ("הגהות מנחם ציון": "סעיף א, ב, ג" that are not the base's סעיפים) — that stays the job of the
 * consistency guards, which lower the confidence of such links after the run. The thresholds below were
 * measured on the real library (docs/AUTOMATION_ENGINE.md §2, "התאמת כותרות").
 */

export type TitleFitVerdict = "fit" | "partial" | "unfit";

export interface TitleFitReason {
  /** stable code, `title-fit/<what>` */
  readonly code: string;
  readonly text: string;
  /** whether this reason argues for the method (true) or against it */
  readonly ok: boolean;
}

export interface TitleFitMetrics {
  /** commentary lines with at least two letters, headings excluded */
  readonly contentLines: number;
  /** of those, lines under a heading with a place (a path) */
  readonly titledLines: number;
  /** headings of the commentary that carry a place (a name or a number) */
  readonly headings: number;
  /** titledLines / contentLines */
  readonly titleDensity: number;
  /** distinct heading paths of the commentary */
  readonly commentaryPaths: number;
  /** distinct heading paths of the base (units) */
  readonly baseUnits: number;
  /** commentary paths that have a place in the base (see "placed") */
  readonly sharedPaths: number;
  /** sharedPaths / commentaryPaths: how much of the commentary's title set is the base's */
  readonly pathShare: number;
  /** titled content lines whose heading path has a place in the base */
  readonly placedLines: number;
  /** placedLines / titledLines */
  readonly placedShare: number;
  /** commentary headings that repeat an earlier heading path (a title per unit means few) / headings */
  readonly duplicateShare: number;
}

export interface TitleFitReport {
  readonly verdict: TitleFitVerdict;
  readonly reasons: readonly TitleFitReason[];
  readonly metrics: TitleFitMetrics;
}

/**
 * A path "has a place" in the base when the headings engine's own aligner (headings/align.ts) puts it on a
 * base unit with no commentary level left over and a cost no higher than a "high" match (1 − 0.85): the same
 * title, the same number, an element one book skips. Exactly equal typed paths are too strict — "רש"י על
 * בראשית" heads its verses "פרק א › פסוק ג" and the base "בראשית › פרק א › פסוק ג" (measured: 0% equal paths,
 * 100% placed by the engine's own judgement).
 */
const PLACE_MAX_PENALTY = 0.15;

/**
 * Thresholds, measured on the real library (see title-fit.local.test.ts, which prints the pairs and the
 * numbers behind each constant, and AUTOMATION_ENGINE.md §2).
 */
export const TITLE_FIT = {
  /** below this share of titled content lines the commentary has no usable titles ("unfit") */
  minDensity: 0.5,
  /** at or above this share of titled lines that sit under a heading path the base also has: "fit" */
  fitPlaced: 0.8,
  /** below this: "unfit"; between: "partial" */
  unfitPlaced: 0.3,
  /** a commentary whose headings repeat a path this often has no title per unit */
  maxDuplicates: 0.2,
  /** fewer headings than this prove nothing about titles (a one-heading file is a title page) */
  minHeadings: 2,
} as const;

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** the base units a path element may be the deepest aligned level of; names are compared exactly (cheap, and "identical titles" is the question) */
const elementKey = (e: PathElement): string => (e.kind === "name" ? `$${e.name}` : e.kind === "daf" ? `d${e.n}` : `#${e.n}`);

export function titleFit(commentary: EngineBook, base: EngineBook): TitleFitReport {
  const opts = { numbering: "lenient", untaggedHeadings: true } as const;
  const cs = analyzeBook(commentary, opts);
  const bs = analyzeBook(base, opts);
  const units = buildUnits(bs);
  const byKey = new Map<string, Unit[]>();
  for (const u of units) {
    const k = elementKey(u.path[u.path.length - 1]!);
    const list = byKey.get(k);
    if (list) list.push(u);
    else byKey.set(k, [u]);
  }
  const actx: AlignContext = {
    baseKinds: bs.kinds,
    baseHasNamed: bs.hasNamed,
    baseHasUnnamed: bs.markerLines > 0 || bs.headings.some((h) => h.elements.some((e) => e.kind === "?")),
    commentaryKinds: cs.kinds,
    commentaryHasNamed: cs.hasNamed,
  };
  const placedCache = new Map<string, boolean>();
  const placed = (path: readonly PathElement[]): boolean => {
    const key = pathKey(path);
    const hit = placedCache.get(key);
    if (hit !== undefined) return hit;
    let ok = false;
    const seen = new Set<Unit>();
    outer: for (const e of path) {
      for (const u of byKey.get(elementKey(e)) ?? []) {
        if (seen.has(u)) continue;
        seen.add(u);
        const a = align(path, u.path, actx);
        if (a && a.missing === 0 && a.penalty <= PLACE_MAX_PENALTY) {
          ok = true;
          break outer;
        }
      }
    }
    placedCache.set(key, ok);
    return ok;
  };

  let contentLines = 0;
  let titledLines = 0;
  let placedLines = 0;
  for (const l of cs.lines) {
    if (l.skip !== null) continue;
    contentLines++;
    if (!l.path.length) continue;
    titledLines++;
    if (placed(l.path)) placedLines++;
  }
  const commentaryKeys = new Set<string>();
  let duplicates = 0;
  let shared = 0;
  for (const h of cs.headings) {
    const key = pathKey(h.path);
    if (commentaryKeys.has(key)) duplicates++;
    else {
      commentaryKeys.add(key);
      if (placed(h.path)) shared++;
    }
  }

  const metrics: TitleFitMetrics = {
    contentLines,
    titledLines,
    headings: cs.headings.length,
    titleDensity: contentLines ? titledLines / contentLines : 0,
    commentaryPaths: commentaryKeys.size,
    baseUnits: units.length,
    sharedPaths: shared,
    pathShare: commentaryKeys.size ? shared / commentaryKeys.size : 0,
    placedLines,
    placedShare: titledLines ? placedLines / titledLines : 0,
    duplicateShare: cs.headings.length ? duplicates / cs.headings.length : 0,
  };

  const reasons: TitleFitReason[] = [];
  const add = (code: string, ok: boolean, text: string) => reasons.push({ code: `title-fit/${code}`, ok, text });
  const T = TITLE_FIT;

  const noTitles = metrics.headings < T.minHeadings || metrics.titleDensity < T.minDensity;
  if (metrics.headings < T.minHeadings) add("no-titles", false, `בספר הפירוש אין כותרות עם מקום (שם או מספר): ${metrics.headings.toLocaleString("he")}. אין לפי מה לקשר לפי כותרות.`);
  else if (metrics.titleDensity < T.minDensity) add("sparse-titles", false, `רק ${pct(metrics.titleDensity)} משורות הפירוש נמצאות תחת כותרת עם מקום, ושאר השורות לא יקושרו לפי כותרות.`);
  else add("titles", true, `${pct(metrics.titleDensity)} משורות הפירוש נמצאות תחת כותרת עם מקום.`);

  if (!noTitles) {
    if (metrics.placedShare >= T.fitPlaced) add("same-titles", true, `לכותרות של ${pct(metrics.placedShare)} משורות הפירוש יש כותרת תואמת בספר הבסיס (אותו שם או אותו מספר).`);
    else if (metrics.placedShare >= T.unfitPlaced) add("some-titles", false, `לכותרות של ${pct(metrics.placedShare)} בלבד משורות הפירוש יש כותרת תואמת בספר הבסיס. שאר השורות לא יקושרו לפי כותרות.`);
    else add("other-titles", false, `לכותרות של ${pct(metrics.placedShare)} בלבד משורות הפירוש יש כותרת תואמת בספר הבסיס: הכותרות בשני הספרים אינן אותן כותרות.`);
    if (metrics.duplicateShare > T.maxDuplicates) add("duplicates", false, `${pct(metrics.duplicateShare)} מכותרות הפירוש חוזרות על מקום שכבר נכתב (אין כותרת אחת לכל יחידה), ולכן המקום בבסיס עלול להיות לא חד־משמעי.`);
  }

  const verdict: TitleFitVerdict = noTitles || metrics.placedShare < T.unfitPlaced ? "unfit" : metrics.placedShare >= T.fitPlaced && metrics.duplicateShare <= T.maxDuplicates ? "fit" : "partial";
  return { verdict, reasons, metrics };
}
