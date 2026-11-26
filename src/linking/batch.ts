import { pushTo } from "../core/collections";
import type { BookRef } from "../core/links/model";
import { sourceIdOfBookKey } from "../core/books";
import { baseTitleKey, declaredBaseTitle, looseTitleKey, titleCorpus } from "../core/links/titles";
import type { Confidence, EngineResult, Reason } from "./automatic/types";

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
  /**
   * The other editions of the base, when the target was chosen among them by a rule (origin, the dependant's own source) and not by
   * evidence or by the user (BaseResolution.undecided). What the pair finds is then capped at "possible" (capUndecided).
   */
  undecided?: readonly BookRef[];
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

export type BaseResolution = { target: BookRef; note?: string; undecided?: readonly BookRef[] } | { reason: string };

/**
 * Two titles that name the same book in the library's naming ("ברכות", "מסכת ברכות", "תלמוד בבלי ברכות"; but not "משנה ברכות"):
 * the base-title key and the corpus. ONLY for telling that a base is open in several editions (#42 C12): book names are still
 * matched and written exactly for the generator (AGENTS.md §3).
 */
export const editionKey = (title: string): string => `${titleCorpus(title)}|${baseTitleKey(title)}`;

const ORIGIN_TEXT: Readonly<Record<BookRef["origin"], string>> = { otzaria: "המאגר הרשמי", sefaria: "המאגר הרשמי (ספריא)", personal: "ספר אישי", unknown: "מקור לא ידוע" };

/**
 * One edition as the user can tell it from the others: its title, where it comes from (origin and source id), and its length
 * when known (a PlanBook or DiscoveryBook carries lineCount) — two editions of different length are not the same text.
 */
export function editionText(b: BookRef): string {
  const lines = (b as { lineCount?: number }).lineCount;
  return `"${b.title}" (${ORIGIN_TEXT[b.origin]}, מקור ${sourceIdOfBookKey(b.key)}${lines !== undefined ? `, ${lines.toLocaleString("he")} שורות` : ""})`;
}

/**
 * The open book a base title names, or why there is none. `k` is the base-title key; `named` is the
 * title as the dependant wrote it, prefixes kept ("משנה ברכות"), used to tell books that share a key
 * apart by their corpus (titles.ts titleCorpus). A base open in several sources (בראשית in the user's
 * folder and in the Otzaria database) is then taken from the source the user chose (index.prefer), else
 * from the dependant's own source — a commentary in a folder is written on the base in that folder —
 * else the official library wins over personal copies; each choice is said in the note (product audit
 * F4). More than one candidate left is ambiguous — never a guess.
 *
 * The last two are rules, not evidence (V7 §2.8, #41 B4): the book chosen by them is a provisional default, the note names every
 * edition with its source, and `undecided` lists the editions passed over, so that every path (batch, max-link, discovery, the
 * guided flow) caps what the pair finds until the user chooses. The source the user chose (index.prefer) and the corpus the title
 * names decide; so does a single book of the title.
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
  const editions = pool;
  /** the rule that chose among the editions, when one did (not the user, not evidence) */
  let rule: string | undefined;
  if (pool.length > 1) {
    const from = (src: string) => pool.filter((b) => sourceIdOfBookKey(b.key) === src);
    const chosen = index.prefer ? from(index.prefer) : [];
    const own = from(sourceIdOfBookKey(self.key));
    if (chosen.length === 1) (note = [note, `"${chosen[0]!.title}" פתוח בכמה קבצים ומסדים; נבחר זה מהקובץ או המסד שבחרתם לספרי הבסיס.`].filter(Boolean).join(" ")), (pool = chosen);
    else if (own.length === 1) (rule = `זה שמאותו מקור כמו "${self.title}"`), (pool = own);
  }
  const official = pool.filter((b) => b.origin !== "personal");
  if (official.length && official.length < pool.length) (rule ??= "זה של המאגר הרשמי, ולא העותק האישי"), (pool = official);
  if (pool.length > 1)
    return { reason: `"${pool[0]!.title}" פתוח ב־${new Set(pool.map((b) => sourceIdOfBookKey(b.key))).size > 1 ? `${pool.length} קבצים ומסדים` : `${pool.length} ספרים באותו שם`}, ולא ברור על איזה מהם הספר כתוב. בחרו למעלה מאיזה מקור לקחת את ספרי הבסיס, או קשרו את הזוג ידנית.` };
  const target = pool[0]!;
  const undecided = rule ? editions.filter((b) => b.key !== target.key) : [];
  if (undecided.length)
    note = [
      note,
      `יש כמה מהדורות של "${target.title}": ${editions.map(editionText).join("; ")}. נבחר ${rule}, וזה כלל ולא ראיה שהספר כתוב עליו. ההצעות מולו לא יהיו מעל "אפשרית" עד שתבחרו את המהדורה במפורש: מקור לספרי הבסיס, או זוג עם הספר עצמו.`,
    ].filter(Boolean).join(" ");
  if (spelled) note = [note, `השם "${named ?? k}" נכתב אחרת מ"${target.title}"; הותאם לפי הכתיב.`].filter(Boolean).join(" ");
  return { target, ...(note && { note }), ...(undecided.length && { undecided }) };
}

/** Lowers "certain" and "high" to "possible", with a warning on each suggestion that says why. */
export function capConfidence(r: EngineResult, levels: readonly Confidence[], why: Reason): EngineResult {
  return { ...r, suggestions: r.suggestions.map((s) => (levels.includes(s.confidence) ? { ...s, confidence: "possible" as const, warnings: [...s.warnings, why] } : s)) };
}

/**
 * What a pair found against a base chosen among editions by a rule (BatchPair.undecided, PlanStep.ambiguousBase): nothing is above
 * "possible", each suggestion says why, and the run says so once. The user lifts it by choosing the edition. `code` tells the paths
 * apart ("batch/undecided-base", "maxlink/ambiguous-base"); the rule and the text are one.
 */
export function capUndecided(r: EngineResult, title: string, code: string): EngineResult {
  const why: Reason = { code, text: `יש כמה ספרים בשם "${title}", והבסיס נבחר לפי כלל ולא לפי ראיה, ולכן ההצעה הזו לא יכולה להיות מעל "אפשרית". בחרו במפורש את הספר (מקור לספרי הבסיס, או זוג עם הספר עצמו) כדי להסיר את ההגבלה.` };
  return { ...capConfidence(r, ["certain", "high"], why), notes: [{ code, text: why.text }, ...r.notes] };
}

/** One commentary against an index of open books, by its title. */
export function pairOne(c: BookRef, index: TitleIndex): BatchPair {
  const named = declaredBaseTitle(c.title);
  if (!named) return { source: c, target: null, reason: 'השם אינו בצורה "… על <ספר>", ולכן לא ידוע על איזה ספר הוא.' };
  const r = resolveBaseKey(baseTitleKey(named), index, c, named);
  return "target" in r ? { source: c, target: r.target, ...(r.note && { note: r.note }), ...(r.undecided && { undecided: r.undecided }) } : { source: c, target: null, reason: r.reason };
}

/** `prefer`: the source the user chose for bases open in several sources (TitleIndex.prefer). */
export function pairByTitle(commentaries: readonly BookRef[], bases: readonly BookRef[], prefer?: string): BatchPair[] {
  const index = titleIndex(bases, prefer);
  return commentaries.map((c) => pairOne(c, index));
}
