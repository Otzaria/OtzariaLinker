import { pushTo } from "../core/collections";
import type { BookRef } from "../core/links/model";
import { sourceIdOfBookKey } from "../core/books";
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
  /** the source the user chose for base books open in several sources (resolveBaseKey); absent = automatic */
  readonly prefer?: string;
}

export function titleIndex(bases: readonly BookRef[], prefer?: string): TitleIndex {
  const exact = new Map<string, BookRef[]>();
  const loose = new Map<string, BookRef[]>();
  for (const b of bases) {
    pushTo(exact, baseTitleKey(b.title), b);
    pushTo(loose, looseTitleKey(b.title), b);
  }
  return { exact, loose, ...(prefer && { prefer }) };
}

export type BaseResolution = { target: BookRef; note?: string } | { reason: string };

/**
 * The open book a base title names, or why there is none. `k` is the base-title key; `named` is the
 * title as the dependant wrote it, prefixes kept ("משנה ברכות"), used to tell books that share a key
 * apart by their corpus (titles.ts titleCorpus). A base open in several sources (בראשית in the user's
 * folder and in the Otzaria database) is then taken from the source the user chose (index.prefer), else
 * from the dependant's own source — a commentary in a folder is written on the base in that folder —
 * else the official library wins over personal copies; each choice is said in the note (product audit
 * F4). More than one candidate left is ambiguous — never a guess.
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
  if (pool.length > 1) {
    const from = (src: string) => pool.filter((b) => sourceIdOfBookKey(b.key) === src);
    const chosen = index.prefer ? from(index.prefer) : [];
    const own = from(sourceIdOfBookKey(self.key));
    if (chosen.length === 1) (note = [note, `"${chosen[0]!.title}" פתוח בכמה מקורות; נבחר זה מהמקור שבחרתם לספרי הבסיס.`].filter(Boolean).join(" ")), (pool = chosen);
    else if (own.length === 1) (note = [note, `"${own[0]!.title}" פתוח בכמה מקורות; נבחר זה שמאותו מקור כמו "${self.title}".`].filter(Boolean).join(" ")), (pool = own);
  }
  const official = pool.filter((b) => b.origin !== "personal");
  if (official.length) pool = official;
  if (pool.length > 1)
    return { reason: `"${pool[0]!.title}" פתוח ב־${new Set(pool.map((b) => sourceIdOfBookKey(b.key))).size > 1 ? `${pool.length} מקורות` : `${pool.length} ספרים באותו שם`}, ולא ברור על איזה מהם הספר כתוב. בחרו למעלה מאיזה מקור לקחת את ספרי הבסיס, או קשרו את הזוג ידנית.` };
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
