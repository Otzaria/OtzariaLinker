import { pushTo } from "../core/collections";
import type { BookRef } from "../core/links/model";
import { baseTitleKey, declaredBaseTitle, looseTitleKey, titleCorpus } from "../core/links/titles";

/*
 * Batch linking (stage 8.4): many commentaries at once, each against the base book its title names.
 * Pairing is by title only ("X על <base>", the same rule the generator uses to decide direction), so
 * it is explainable and never guesses: a book whose base is not open, or is ambiguous, is listed as
 * unpaired with the reason instead of being linked to a lookalike.
 */
export interface BatchPair {
  source: BookRef;
  target: BookRef | null;
  /** why there is no target (Hebrew), when target is null */
  reason?: string;
  /** how an ambiguous or differently spelled base name was resolved (Hebrew) */
  note?: string;
}

/** Open books by their base-title key, built once and shared by many lookups (the max-link planner pairs thousands). */
export interface TitleIndex {
  readonly exact: ReadonlyMap<string, readonly BookRef[]>;
  /** by looseTitleKey: the same title in another spelling, tried only when `exact` finds nothing */
  readonly loose: ReadonlyMap<string, readonly BookRef[]>;
}

export function titleIndex(bases: readonly BookRef[]): TitleIndex {
  const exact = new Map<string, BookRef[]>();
  const loose = new Map<string, BookRef[]>();
  for (const b of bases) {
    pushTo(exact, baseTitleKey(b.title), b);
    pushTo(loose, looseTitleKey(b.title), b);
  }
  return { exact, loose };
}

export type BaseResolution = { target: BookRef; note?: string } | { reason: string };

/**
 * The open book a base title names, or why there is none. `k` is the base-title key; `named` is the
 * title as the dependant wrote it, prefixes kept ("משנה ברכות"), used to tell books that share a key
 * apart by their corpus (titles.ts titleCorpus). Then the official library wins over personal copies;
 * more than one candidate left is ambiguous — never a guess.
 */
export function resolveBaseKey(k: string, index: TitleIndex, self: BookRef, named?: string): BaseResolution {
  let hits = (index.exact.get(k) ?? []).filter((b) => b.key !== self.key);
  let spelled = false;
  if (!hits.length) {
    hits = (index.loose.get(looseTitleKey(named ?? k)) ?? []).filter((b) => b.key !== self.key);
    spelled = hits.length > 0;
  }
  if (!hits.length) return { reason: `ספר הבסיס "${named ?? k}" אינו פתוח באף מקור.` };
  let pool = hits;
  let note: string | undefined;
  if (pool.length > 1 && named !== undefined) {
    const corpus = titleCorpus(named);
    const same = pool.filter((b) => titleCorpus(b.title) === corpus);
    if (same.length && same.length < pool.length) {
      note = `השם "${named}" מתאים ל־${pool.length} ספרים (${pool.map((b) => `"${b.title}"`).join(", ")}); נבחר ${same.length === 1 ? `"${same[0]!.title}"` : "מהם"} כי ${corpus ? "השם מציין את אותו חיבור" : "השם אינו מציין משנה או ירושלמי"}.`;
      pool = same;
    }
  }
  const official = pool.filter((b) => b.origin !== "personal");
  if (official.length) pool = official;
  if (pool.length > 1) return { reason: `נמצאו ${pool.length} ספרים בשם "${pool[0]!.title}". בחרו את הבסיס ידנית.` };
  const target = pool[0]!;
  if (spelled) note = [note, `השם "${named ?? k}" נכתב אחרת מ"${target.title}"; הותאם לפי הכתיב.`].filter(Boolean).join(" ");
  return { target, ...(note && { note }) };
}

/** One commentary against an index of open books, by its title. */
export function pairOne(c: BookRef, index: TitleIndex): BatchPair {
  const named = declaredBaseTitle(c.title);
  if (!named) return { source: c, target: null, reason: 'השם אינו בצורה "… על <ספר>", ולכן לא ידוע על איזה ספר הוא.' };
  const r = resolveBaseKey(baseTitleKey(named), index, c, named);
  return "target" in r ? { source: c, target: r.target, ...(r.note && { note: r.note }) } : { source: c, target: null, reason: r.reason };
}

export function pairByTitle(commentaries: readonly BookRef[], bases: readonly BookRef[]): BatchPair[] {
  const index = titleIndex(bases);
  return commentaries.map((c) => pairOne(c, index));
}
