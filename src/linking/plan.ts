import { pushTo } from "../core/collections";
import type { DbLinkBookCount } from "../core/links/db-links";
import type { BookRef } from "../core/links/model";
import { baseTitleKey, declaredBaseTitle, isMergeableCompanionTitle, normalizeTitle, titleCorpus, titleDeclaresDependencyOn } from "../core/links/titles";
import { ENGINES, type EngineId } from "./automatic";
import { resolveBaseKey, titleIndex, type TitleIndex } from "./batch";
import { commentatorOfTitle } from "./automatic/dibur-hamatchil/addressee";

/*
 * The max-link planner ("קישור מרבי", stage 8.4): given the books the user selected and every open
 * book, decide which engine runs on which book or pair, and say why in Hebrew. Pure and synchronous —
 * the plan is shown for review before anything runs, and the worker only executes its steps.
 *
 * Relations, strongest evidence first:
 *   1. the database's own declaration (book_base_text, SourceBook.bases);
 *   2. the title: "X על Y" (the generator's rule, batch.ts) — and, before it, the notes-book patterns
 *      "הערות … על Y" / "הערות ל<Y>", which are footnotes companions, not commentaries;
 *   3. the links the database already has (PlanBook.linkedBases: default_commentator, and the
 *      COMMENTARY links into the book — always stored base → commentary). This is what pairs
 *      "בית יוסף" with "טור" and "שער הציון" with "משנה ברורה": no declaration, no "X על Y", but
 *      thousands of COMMENTARY links (LIBRARY_BENCHMARK.md §6.1, §7: 99.8% and 100% re-produced).
 *      It also links a commentary on a commentary to the base of its base, when the database does
 *      ("שפתי חכמים" → "רש"י על בראשית" → "בראשית"). TARGUM and MIDRASH links are read the same way
 *      (also always stored base → dependant), with a floor (LINKED_MIN): a translation or a midrash on
 *      the five books with no book_base_text ("תרגום ותפסיר רסג", "מדרש אגדה") is linked to each
 *      book through its own section;
 *   4. the corpus: a Mishnah tractate and the Bavli tractate of the same name ("משנה שבת" ↔ "שבת"),
 *      which quotes it word for word (MISHNAH_IN_TALMUD; mishnahInTalmud below).
 * A relation runs when either side is selected, so "this book" covers both its base and the open
 * commentaries written on it. Nothing is guessed: no relation → the book is listed with the reason.
 */

/**
 * Engines that read TWO books (input source → input target). Every other registered engine reads one book.
 * "pattern" is listed so it is never taken for a single-book engine; the planner never schedules it
 * (stepsFor picks engines per relation, and a pattern is the user's own).
 */
export const PAIR_ENGINES = ["headings", "dibur-hamatchil", "footnotes", "pattern"] as const satisfies readonly EngineId[];
export type PairEngineId = (typeof PAIR_ENGINES)[number];
/**
 * Single-book engines (e.g. citations, "מראי מקומות"): they read one book and link it to lines in any
 * open book. They are exactly the registered engines that are not pair engines, so registering one in
 * `ENGINES` is enough for the planner; the worker needs its runner (workers/maxlink-job.ts).
 */
export type SingleEngineId = Exclude<EngineId, PairEngineId>;

export const isPairEngine = (e: EngineId): e is PairEngineId => (PAIR_ENGINES as readonly EngineId[]).includes(e);

export function singleBookEngines(): SingleEngineId[] {
  return ENGINES.map((e) => e.id).filter((id): id is SingleEngineId => !isPairEngine(id));
}

/** A book as the planner sees it: a BookRef plus what its source declares about it. */
export interface PlanBook extends BookRef {
  /** keys of the books this one is written on (book_base_text) */
  readonly bases?: readonly string[];
  /** book.dependenceType: commentary | targum | midrash | guides */
  readonly dependence?: string;
  /** keys of the books the source's existing links show this one is a commentary on (see the header) */
  readonly linkedBases?: readonly string[];
  /**
   * For the linkedBases shown by TARGUM or MIDRASH links rather than COMMENTARY ones: base key → kind.
   * A base absent here is a commentary base.
   */
  readonly linkedKinds?: Readonly<Record<string, LinkedKind>>;
}

/** What the existing links say a dependant is, besides a commentary (evidenceFromCounts). */
export type LinkedKind = "targum" | "midrash";

/** One pair the existing links relate: `dependant` is written on `base` (as a commentary, unless `kind`). */
export interface LinkedEvidence {
  readonly dependant: string;
  readonly base: string;
  readonly kind?: LinkedKind;
}

/*
 * A floor for TARGUM and MIDRASH evidence. Sefaria's MIDRASH layer holds stray single links between
 * base texts ("בראשית" → "דברים", "משנה שבת" → "ראש השנה"; 1–4 links each), which would make one Torah
 * book a "midrash" on another. Every pair a translation or a midrash is really written on has hundreds
 * (the smallest: "תרגום יונתן על עובדיה", 21; "מדרש אגדה" → "ויקרא", 382). COMMENTARY links have no
 * floor: the library writes them only between a commentary and its base.
 */
export const LINKED_MIN = 20;

/**
 * The relations one book's link summary shows (DbLinkSummary.byBook of `bookKey`): every type here is
 * stored base → dependant, so "in" means this book is the dependant. Pure; MaxLinkState.gatherEvidence
 * and the library benchmark both read evidence through it.
 */
export function evidenceFromCounts(bookKey: string, byBook: readonly DbLinkBookCount[]): LinkedEvidence[] {
  const out: LinkedEvidence[] = [];
  const add = (dependant: string, base: string, kind?: LinkedKind) => {
    if (dependant !== base) out.push({ dependant, base, ...(kind && { kind }) });
  };
  for (const b of byBook) {
    if (b.commentaryIn) add(bookKey, b.bookKey);
    if (b.commentaryOut) add(b.bookKey, bookKey);
    if (b.targumIn >= LINKED_MIN) add(bookKey, b.bookKey, "targum");
    if (b.targumOut >= LINKED_MIN) add(b.bookKey, bookKey, "targum");
    if (b.midrashIn >= LINKED_MIN) add(bookKey, b.bookKey, "midrash");
    if (b.midrashOut >= LINKED_MIN) add(b.bookKey, bookKey, "midrash");
  }
  return out;
}

/** Folds evidence into PlanBook fields: a pair seen as a commentary stays a commentary. */
export function linkedFields(evidence: readonly LinkedEvidence[]): Map<string, { linkedBases: string[]; linkedKinds: Record<string, LinkedKind> }> {
  const byDep = new Map<string, Map<string, LinkedKind | "commentary">>();
  for (const e of evidence) {
    const m = byDep.get(e.dependant) ?? new Map<string, LinkedKind | "commentary">();
    if (m.get(e.base) !== "commentary") m.set(e.base, e.kind ?? "commentary");
    byDep.set(e.dependant, m);
  }
  const out = new Map<string, { linkedBases: string[]; linkedKinds: Record<string, LinkedKind> }>();
  for (const [dep, m] of byDep) {
    const linkedKinds: Record<string, LinkedKind> = {};
    for (const [base, kind] of m) if (kind !== "commentary") linkedKinds[base] = kind;
    out.set(dep, { linkedBases: [...m.keys()], linkedKinds });
  }
  return out;
}

/**
 * "mishnah-in-talmud": a Mishnah tractate and the Bavli tractate of the same name. Not a commentary:
 * the Gemara quotes the Mishnah word for word, so only dibur-hamatchil runs, Mishnah → Bavli, and the
 * suggestions carry the type the database stores them under (MISHNAH_IN_TALMUD).
 */
export type RelationKind = "commentary" | "notes" | "mishnah-in-talmud";
export type RelationVia = "base-text" | "title" | "links" | "corpus";

/**
 * A commentary written on SEVERAL bases is linked to each base only through the part of it that is
 * headed by that base ("בראשית", "ספר שמות" — linking/sections.ts, applied by the job once the book is
 * read). When no heading names the base, only dibur-hamatchil runs, on the whole book, and its
 * suggestions are left for review (workers/maxlink-job.ts runScoped). Measured on the real database
 * (docs/AUTOMATION_ENGINE.md §5.1): headings on a whole book are wrong too often even when the title
 * names the base — "המאור הגדול על שבועות" follows the Rif's pages, not the Talmud's.
 */
export interface RelationScope {
  section: string;
}

/**
 * A commentary on a commentary, linked to the base of its base THROUGH the commentary it explains
 * ("מחצית השקל" explains the "מגן אברהם", which is written on the "שולחן ערוך"). Its headings follow
 * the intermediate's numbering (its "סעיף ב" is the מגן אברהם's ס"ק ב), so the engines link it to the
 * intermediate, and each place found there is carried to the base by the links the database already
 * has between the intermediate and the base (workers/maxlink-job.ts runThrough). Measured on the real
 * database: 12,171 of the 12,180 lines of מחצית השקל that the library links to the שולחן ערוך are
 * linked exactly where that composition leads; פרי מגדים 9,421 of 9,501; בועז on the Mishnah 28/32.
 */
export interface RelationThrough {
  /** the intermediate commentary */
  book: BookRef;
  /** when the dependant explains several intermediates: the part written on this one */
  scope?: RelationScope;
}

export interface Relation {
  kind: RelationKind;
  /** the commentary, or the notes book */
  dependant: BookRef;
  /** the book it is written on (for notes: the main book with the markers) */
  base: BookRef;
  via: RelationVia;
  /** the database and the title disagree, a merge-prone notes title… (Hebrew) */
  caveats: string[];
  /** set when the dependant is written on several bases (see RelationScope) */
  scope?: RelationScope;
  /** the existing links show the dependant is a translation / a midrash of the base (PlanBook.linkedKinds) */
  dependence?: LinkedKind;
  /** set when the dependant is linked to this base through the commentary it explains (RelationThrough) */
  through?: readonly RelationThrough[];
}

/** One unit of work. `pair` steps run an engine on (source → target) in the engine's input direction. */
export type PlanStep =
  | {
      id: string;
      kind: "pair";
      engine: PairEngineId;
      source: BookRef;
      target: BookRef;
      relation: Relation;
      why: string;
      /** engine options the plan sets for this pair (e.g. declaredType "targum"); the user's own options win */
      options?: Readonly<Record<string, unknown>>;
    }
  | { id: string; kind: "single"; engine: SingleEngineId; source: BookRef; why: string };

export interface PlanBookRow {
  book: BookRef;
  /** why each engine runs on this book, or what was found about it (Hebrew) */
  decisions: string[];
  /** steps that involve this book */
  steps: number;
  /** set when nothing runs on the book: the reason (Hebrew) */
  skipped?: string;
}

export interface MaxLinkPlan {
  steps: PlanStep[];
  /** one row per selected book, in selection order */
  books: PlanBookRow[];
  /** selected books with at least one relation */
  identified: number;
  /** steps per engine, for the review ("untick an engine") */
  perEngine: Partial<Record<EngineId, number>>;
}

export interface PlanInput {
  /** keys of the selected books */
  selected: readonly string[];
  /** every open book (the selected ones included) */
  library: readonly PlanBook[];
  /** engines the user left ticked; default: all */
  engines?: ReadonlySet<EngineId>;
  /** single-book engines available (default: every registered non-pair engine) */
  singleEngines?: readonly SingleEngineId[];
}

const NOTES_PREFIX = "הערות";

/**
 * The base-title key a notes book declares, or null when the title is not a notes title:
 *   "הערות על X", "הערות באותיות על X", "הערות שוליים על X" … — starts with "הערות" and names X after " על ";
 *   "הערות לX" — the safe name the guide recommends for a notes book that must stay a book
 *   (docs/contracts/OTZARIA_COMPATIBILITY.md item 8).
 * "כפי אהרן הערות על …" does not start with "הערות": it is a commentary by its title.
 */
export function notesBaseKey(title: string): string | null {
  const named = notesBaseTitle(title);
  return named === null ? null : baseTitleKey(named);
}

/** The base title a notes title names, prefixes kept ("הערות על משנה ברכות" → "משנה ברכות"), or null. */
function notesBaseTitle(title: string): string | null {
  const t = normalizeTitle(title);
  if (!t.startsWith(NOTES_PREFIX)) return null;
  const rest = t.slice(NOTES_PREFIX.length);
  if (rest && !/^\s/.test(rest)) return null; // "הערותיו", "הערותי…" are other words
  const named = declaredBaseTitle(t);
  if (named) return named;
  const m = /^\s+ל(\S.*)$/.exec(rest);
  return m ? m[1]! : null;
}

const isTargum = (b: PlanBook) => b.dependence?.toLowerCase() === "targum" || normalizeTitle(b.title).startsWith("תרגום");

const quote = (t: string) => `"${t}"`;

function ref(b: BookRef): BookRef {
  return { key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }) };
}

/** The relations a book has on its own (as a dependant: one, or one per base), or why it has none. */
export function relationsOf(book: PlanBook, byKey: ReadonlyMap<string, PlanBook>, index: TitleIndex): Relation[] | { problem: string } {
  const own = ownRelations(book, byKey, index);
  const talmud = mishnahInTalmud(book, byKey, index);
  if ("problem" in own) {
    const linked = linkedRelations(book, byKey);
    return linked.length || talmud.length ? [...linked, ...talmud] : own;
  }
  return [...own, ...baseOfBase(book, own, byKey), ...talmud];
}

/** A book that could be a tractate on its own: no "X על Y", no dependenceType. */
const isPlainText = (b: PlanBook): boolean => declaredBaseTitle(b.title) === null && !b.dependence;

/*
 * MISHNAH_IN_TALMUD (2,390 links in the database, 37 tractates): every Mishnah of a Bavli tractate is
 * quoted in it word for word, before its Gemara. Both books are base texts, so neither declares the
 * other; the corpus their titles name does ("משנה שבת" and "שבת" share the base key "שבת", and a bare
 * name is the Bavli — titles.ts titleCorpus, the rule cf710d6 introduced for "X על ברכות"). Measured
 * with the library benchmark's what-if (LIBRARY_BENCHMARK.md §7): dibur-hamatchil Mishnah → Bavli
 * re-produced 72%–81% of the links, its "certain" all correct. The Yerushalmi is not paired: the
 * database has no MISHNAH_IN_TALMUD link into it.
 */
function mishnahInTalmud(book: PlanBook, byKey: ReadonlyMap<string, PlanBook>, index: TitleIndex): Relation[] {
  if (titleCorpus(book.title) !== "mishnah" || !isPlainText(book)) return [];
  const hits = (index.exact.get(baseTitleKey(book.title)) ?? [])
    .map((b) => byKey.get(b.key))
    .filter((b): b is PlanBook => !!b && b.key !== book.key && titleCorpus(b.title) === "" && isPlainText(b));
  const official = hits.filter((b) => b.origin !== "personal");
  const pool = official.length ? official : hits;
  if (pool.length !== 1) return []; // none, or two books of the Bavli by that name: never a guess
  const bavli = pool[0]!;
  return [
    {
      kind: "mishnah-in-talmud",
      dependant: ref(book),
      base: ref(bavli),
      via: "corpus",
      caveats: [`${quote(book.title)} היא משנה, ו־${quote(bavli.title)} היא מסכת הבבלי באותו שם: כל משנה מובאת בגמרא כלשונה.`],
    },
  ];
}

const linkedOpen = (book: PlanBook, byKey: ReadonlyMap<string, PlanBook>): PlanBook[] =>
  [...new Set(book.linkedBases ?? [])].filter((k) => k !== book.key).map((k) => byKey.get(k)).filter((b): b is PlanBook => !!b);

/** The base keys a book is written on: declared, or shown by the links. */
const basesOf = (b: PlanBook | undefined): readonly string[] => [...(b?.bases ?? []), ...(b?.linkedBases ?? [])];

/**
 * Relations from the existing links alone (PlanBook.linkedBases), for a book with no declaration and
 * no usable title. One base: an ordinary relation. Several: when they form one chain (each is written
 * on the next: "רש"י על בראשית" on "בראשית"), all of them, unscoped — a commentary on a commentary
 * follows the same chapters and verses. Otherwise each through its own section, like book_base_text.
 */
function linkedRelations(book: PlanBook, byKey: ReadonlyMap<string, PlanBook>): Relation[] {
  if (notesBaseKey(book.title) !== null) return [];
  const open = linkedOpen(book, byKey);
  if (!open.length) return [];
  const kindOf = (base: PlanBook): LinkedKind | undefined => book.linkedKinds?.[base.key];
  const keys = new Set(open.map((b) => b.key));
  const inChain = (b: PlanBook) => basesOf(b).some((k) => keys.has(k)) || open.some((o) => basesOf(o).includes(b.key));
  const chain = open.length === 1 || open.every(inChain);
  const relation = (base: PlanBook, caveat: string, scope?: RelationScope): Relation => {
    const dependence = kindOf(base);
    return { kind: "commentary", dependant: ref(book), base: ref(base), via: "links", caveats: [caveat], ...(scope && { scope }), ...(dependence && { dependence }) };
  };
  if (chain) return open.map((base) => relation(base, `לפי הקישורים שכבר יש במסד: הוא מקושר אליו ${AS_TEXT[kindOf(base) ?? "commentary"]}.`));
  // the five books of the Torah under one translation or midrash ("תרגום ותפסיר רסג", "מדרש אגדה")
  // divide themselves by a heading per book, like the multi-base books of book_base_text
  const kinds = new Set(open.map((b) => kindOf(b) ?? "commentary"));
  const as = kinds.size === 1 ? ` ${AS_TEXT[[...kinds][0]!]}` : "";
  const note = `לפי הקישורים שכבר יש במסד הספר מקושר ל־${open.length} ספרים${as}. כל בסיס מקושר רק דרך החלק בספר שהכותרת שלו היא שם הבסיס.`;
  return open.map((base) => relation(base, note, { section: base.title }));
}

const AS_TEXT: Readonly<Record<LinkedKind | "commentary", string>> = { commentary: "כפירוש", targum: "כתרגום", midrash: "כמדרש" };

/**
 * A commentary on a commentary is linked to the base of its base too, when the database links it
 * there ("שפתי חכמים" is written on "רש"י על בראשית", and the library links it to "בראשית" as well:
 * 89K COMMENTARY links, LIBRARY_BENCHMARK.md §6.1). Unscoped: it follows the same chapters and verses.
 */
function baseOfBase(book: PlanBook, own: readonly Relation[], byKey: ReadonlyMap<string, PlanBook>): Relation[] {
  if (!book.linkedBases?.length) return [];
  const direct = own.filter((r) => r.kind === "commentary" && !r.scope);
  const have = new Set(own.map((r) => r.base.key));
  const out: Relation[] = [];
  for (const b of linkedOpen(book, byKey)) {
    // a TARGUM / MIDRASH link to the base of the base says nothing about a commentary on a commentary
    if (have.has(b.key) || book.linkedKinds?.[b.key]) continue;
    const via = direct.find((r) => basesOf(byKey.get(r.base.key)).includes(b.key));
    if (!via) continue;
    have.add(b.key);
    out.push({ kind: "commentary", dependant: ref(book), base: ref(b), via: "links", caveats: [`פירוש על ${quote(via.base.title)}, שכתוב על ${quote(b.title)}; המסד מקשר אותו גם ל־${quote(b.title)}.`] });
  }
  return out;
}

/*
 * The declared bases of a commentary on a commentary form a chain: "מחצית השקל" is declared on the
 * "מגן אברהם" and on the "שולחן ערוך", and the "מגן אברהם" is itself written on the "שולחן ערוך" (213
 * of the 258 multi-base books of the database: בועז on יכין and the Mishnah, the פרי מגדים on the מגן
 * אברהם, the ט"ז and the שולחן ערוך…). Such a book is not divided into a part per base — it follows
 * the intermediate commentary, numbering included — so a section per base finds nothing (today: only
 * dibur-hamatchil, everything left for review). Instead: the intermediate is the base (unscoped when
 * there is one, each in its own section when several), and each root is reached through them.
 * Null when the bases are not one chain, or the dependant itself is part of it.
 */
function chainRelations(book: PlanBook, declared: readonly PlanBook[], caveats: readonly string[]): Relation[] | null {
  const keys = new Set(declared.map((b) => b.key));
  const writtenOn = (b: PlanBook) => basesOf(b).filter((k) => keys.has(k) && k !== b.key);
  const mids = declared.filter((b) => writtenOn(b).length > 0);
  const midKeys = new Set(mids.map((b) => b.key));
  const roots = declared.filter((b) => !midKeys.has(b.key));
  if (!mids.length || !roots.length || roots.some((r) => !mids.some((m) => writtenOn(m).includes(r.key)))) return null;
  if (mids.some((m) => writtenOn(m).some((k) => midKeys.has(k)))) return null; // a longer chain: not this rule
  const scoped = mids.length > 1;
  const out: Relation[] = mids.map((m) => ({
    kind: "commentary" as const,
    dependant: ref(book),
    base: ref(m),
    via: "base-text" as const,
    caveats: [...caveats, scoped ? `לפי המסד הספר מפרש ${mids.length} פירושים; כל אחד מקושר רק דרך החלק בספר שהכותרת שלו היא שמו.` : `לפי המסד הספר הוא פירוש על ${quote(m.title)}, ולכן הכותרות שלו הולכות לפי ${quote(m.title)}.`],
    ...(scoped && { scope: { section: m.title } }),
  }));
  for (const r of roots) {
    const via = mids.filter((m) => writtenOn(m).includes(r.key));
    out.push({
      kind: "commentary",
      dependant: ref(book),
      base: ref(r),
      via: "base-text",
      caveats: [...caveats, `${quote(book.title)} מפרש את ${via.map((m) => quote(m.title)).join(" ואת ")}, שכתוב על ${quote(r.title)}: כל שורה מקושרת קודם למקום שהיא מפרשת שם, ומשם ל־${quote(r.title)} לפי הקישורים שכבר יש במסד ביניהם.`],
      through: via.map((m) => ({ book: ref(m), ...(scoped && { scope: { section: m.title } }) })),
    });
  }
  return out;
}

/** The relations a book's declaration or title gives it (relationsOf without the existing links). */
function ownRelations(book: PlanBook, byKey: ReadonlyMap<string, PlanBook>, index: TitleIndex): Relation[] | { problem: string } {
  const notesNamed = notesBaseTitle(book.title);
  const kind: RelationKind = notesNamed !== null ? "notes" : "commentary";
  const named = notesNamed ?? declaredBaseTitle(book.title);
  const titleKey = named === null ? null : baseTitleKey(named);
  const caveats: string[] = [];
  if (kind === "notes" && isMergeableCompanionTitle(book.title))
    caveats.push(`ספר בשם "הערות על…" ממוזג באוצריא לתוך ספר הבסיס רק כשאין עוגן על שורות ההערות. מנוע ההערות כותב עוגן בכל רשומה, ולכן הקישורים שלו מבטלים את המיזוג: ההערות יישארו ספר נפרד והקישורים יישמרו. אם קובץ הקישורים של הבסיס בספרייה כבר ממזג את ההערות, זה ישנה את מה שמוצג באוצריא — הבדיקה לפני הייצוא תגיד.`);

  const declaredKeys = (book.bases ?? []).filter((k) => k !== book.key);
  const declared = declaredKeys.map((k) => byKey.get(k)).filter((b): b is PlanBook => !!b);
  // several bases (even when only some are open): each base through its own section of the book
  if (declaredKeys.length > 1) {
    if (kind === "notes")
      return { problem: `לפי המסד ספר ההערות כתוב על ${declaredKeys.length} ספרים, ושיטת הערות השוליים מקשרת ספר הערות לספר אחד. קשרו אותו בזוג ספרים.` };
    if (!declared.length) return { problem: "לפי המסד הספר כתוב על כמה ספרים, ואף אחד מהם אינו פתוח עכשיו. פתחו אותם ונסו שוב." };
    const chained = kind === "commentary" && declared.length === declaredKeys.length ? chainRelations(book, declared, caveats) : null;
    if (chained) return chained;
    const note = `לפי המסד הספר כתוב על ${declaredKeys.length} ספרים. כל בסיס מקושר רק דרך החלק בספר שהכותרת שלו היא שם הבסיס.`;
    return declared.map((base) => ({
      kind,
      dependant: ref(book),
      base: ref(base),
      via: "base-text" as const,
      caveats: [...caveats, note],
      scope: { section: base.title },
    }));
  }
  if (declared.length === 1) {
    const base = declared[0]!;
    if (titleKey !== null && titleKey !== baseTitleKey(base.title)) caveats.push(`השם מזכיר ספר אחר מזה שהמסד מציין; הכלי הולך לפי המסד (${quote(base.title)}).`);
    return [{ kind, dependant: ref(book), base: ref(base), via: "base-text", caveats }];
  }
  if (titleKey === null) {
    const declaredButClosed = (book.bases?.length ?? 0) > 0;
    return {
      problem: declaredButClosed
        ? "לפי המסד הספר כתוב על ספר שאינו פתוח עכשיו. פתחו את ספר הבסיס ונסו שוב."
        : 'אין לו ספר בסיס: המסד לא מציין ספר שהוא כתוב עליו, והשם אינו בצורה "… על <ספר>" או "הערות ל<ספר>".',
    };
  }
  const r = resolveBaseKey(titleKey, index, book, named ?? undefined);
  if ("reason" in r) return { problem: r.reason };
  if (r.note) caveats.push(r.note);
  return [{ kind, dependant: ref(book), base: ref(r.target), via: "title", caveats }];
}

/*
 * A commentary on the Talmud quotes not only the Gemara but also רש"י / תוספות and the other
 * intermediate commentators ("תוס' ד"ה X"); the DH engine sets those lines aside when the base is the
 * text and links ONLY them when the base is that commentator (dibur-hamatchil/addressee.ts). So when
 * such a commentator on the same base is open, the plan adds that pair too — otherwise those lines
 * are never linked (measured: 2,469 lines in the DH validation samples).
 */
function intermediateSteps(selected: readonly string[], byKey: ReadonlyMap<string, PlanBook>, relations: ReadonlyMap<string, Relation[]>, commentariesOn: ReadonlyMap<string, Relation[]>): Extract<PlanStep, { kind: "pair" }>[] {
  const out: Extract<PlanStep, { kind: "pair" }>[] = [];
  for (const k of selected) {
    const book = byKey.get(k);
    // a translation is not read by its opening words (stepsFor runs only headings on it)
    if (!book || isTargum(book)) continue;
    for (const own of relations.get(k) ?? []) {
      // a midrash or a translation (by its links) does not quote רש"י or תוספות
      if (own.kind !== "commentary" || own.scope || own.through || own.dependence || own.dependant.key !== k) continue;
      const self = commentatorOfTitle(own.dependant.title)?.key;
      for (const sib of commentariesOn.get(own.base.key) ?? []) {
        const who = commentatorOfTitle(sib.dependant.title);
        if (!who || who.key === self || sib.dependant.key === k) continue;
        const relation: Relation = { kind: "commentary", dependant: own.dependant, base: sib.dependant, via: "title", caveats: [] };
        out.push({
          id: `dibur-hamatchil|${k}>${sib.dependant.key}`,
          kind: "pair",
          engine: "dibur-hamatchil",
          source: own.dependant,
          target: sib.dependant,
          relation,
          why: `${quote(own.dependant.title)} כתוב על ${quote(own.base.title)}, ושורות שבהן הוא מפרש את דברי ${who.name} ("${who.name} ד"ה …", בא"ד) שייכות ל־${quote(sib.dependant.title)}. דיבור המתחיל מקשר רק אותן.`,
          options: { addressedOnly: true },
        });
      }
    }
  }
  return out;
}

const VIA_TEXT: Record<RelationVia, string> = { "base-text": "לפי המסד", title: "לפי השם", links: "לפי הקישורים שבמסד", corpus: "לפי השמות: משנה ובבלי" };

/*
 * A translation (book.dependenceType "targum", or "תרגום…") linked by headings is declared "targum",
 * not "source", when the generator will store it as TARGUM the right way round: the base is a base
 * book and the translation's title names it ("X על <base>"), so the record flips and keeps its type
 * (LINK_FORMATS §1.5, Generator.kt:2275-2291). Then the app shows the translation chip; "source" made
 * it COMMENTARY (compatibility review B8). Otherwise "targum" would be downgraded to OTHER or stored
 * backwards, so "source" (COMMENTARY) stays.
 */
const targumTypeOk = (dep: BookRef, base: BookRef): boolean => base.isBaseBook === true && titleDeclaresDependencyOn(dep.title, base.title);

function stepsFor(rel: Relation, depBook: PlanBook): { engine: PairEngineId; source: BookRef; target: BookRef; why: string; options?: Readonly<Record<string, unknown>> }[] {
  const d = quote(rel.dependant.title);
  const b = quote(rel.base.title);
  const scoped = rel.scope
    ? ` רק החלק שתחת הכותרת ${b}; אם אין כותרת כזו, רק דיבור המתחיל, וההצעות שלו לבדיקה.`
    : "";
  const tail = (rel.caveats.length ? ` ${rel.caveats.join(" ")}` : "") + scoped;
  if (rel.kind === "notes")
    return [
      {
        engine: "footnotes",
        source: rel.base,
        target: rel.dependant,
        why: `${d} הוא ספר הערות על ${b} (${VIA_TEXT[rel.via]}). שיטת הערות השוליים מתאימה כל סימן הערה ב־${b} לשורה בספר ההערות שנפתחת באותו סימן.${tail}`,
      },
    ];
  if (rel.kind === "mishnah-in-talmud")
    return [
      {
        engine: "dibur-hamatchil",
        source: rel.dependant,
        target: rel.base,
        why: `${d} מובאת ב־${b} (${VIA_TEXT[rel.via]}). שיטת דיבור המתחיל מחפשת את מילות הפתיחה של כל משנה בגמרא. הקישורים נכתבים מסוג "משנה בתלמוד" (mishnah_in_talmud), כמו במסד; הגנרטור שומר סוג זה כפי שנכתב, בלי היפוך ובלי הורדה ל"אחר".${tail}`,
        options: { declaredType: "mishnah_in_talmud" },
      },
    ];
  const targum = isTargum(depBook) || rel.dependence === "targum";
  const asTargum = targum && targumTypeOk(rel.dependant, rel.base);
  const out: { engine: PairEngineId; source: BookRef; target: BookRef; why: string; options?: Readonly<Record<string, unknown>> }[] = [
    {
      engine: "headings",
      source: rel.dependant,
      target: rel.base,
      why: `${d} כתוב על ${b} (${VIA_TEXT[rel.via]}). שיטת הכותרות מקשרת כל שורה בפירוש לפי הכותרות שמעליה (פרק ופסוק, סימן וסעיף, דף ועמוד).${asTargum ? " זה תרגום, ולכן הקישורים נכתבים מסוג \"תרגום\" (targum) ויוצגו באוצריא כתרגום." : ""}${tail}`,
      ...(asTargum && { options: { declaredType: "targum" } }),
    },
  ];
  if (!targum)
    out.push({
      engine: "dibur-hamatchil",
      source: rel.dependant,
      target: rel.base,
      why: `${d} כתוב על ${b} (${VIA_TEXT[rel.via]}). שיטת דיבור המתחיל מחפשת את מילות הפתיחה של כל קטע בטקסט של ${b}.${tail}`,
    });
  return out;
}

export function planMaxLink(input: PlanInput): MaxLinkPlan {
  const enabled = (e: EngineId) => !input.engines || input.engines.has(e);
  const byKey = new Map(input.library.map((b) => [b.key, b] as const));
  const index = titleIndex(input.library);
  const selected = [...new Set(input.selected)].filter((k) => byKey.has(k));
  const isSelected = new Set(selected);

  // every relation that touches a selected book: as the dependant, or as the base of an open dependant
  const relations = new Map<string, Relation[]>(); // by dependant key
  const problems = new Map<string, string>();
  /** every open commentary on a base, selected or not: the intermediate commentators come from here */
  const commentariesOn = new Map<string, Relation[]>();
  for (const b of input.library) {
    const rs = relationsOf(b, byKey, index);
    if ("problem" in rs) {
      if (isSelected.has(b.key)) problems.set(b.key, rs.problem);
      continue;
    }
    for (const r of rs) if (r.kind === "commentary" && !r.scope && !r.through) pushTo(commentariesOn, r.base.key, r);
    const touching = rs.filter((r) => isSelected.has(r.dependant.key) || isSelected.has(r.base.key));
    if (touching.length) relations.set(b.key, touching);
  }

  const steps: PlanStep[] = [];
  const seen = new Set<string>();
  const touches = new Map<string, number>();
  const bump = (k: string) => touches.set(k, (touches.get(k) ?? 0) + 1);
  for (const [depKey, rels] of relations)
    for (const rel of rels)
      for (const s of stepsFor(rel, byKey.get(depKey)!)) {
      if (!enabled(s.engine)) continue;
      const id = `${s.engine}|${s.source.key}>${s.target.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      steps.push({ id, kind: "pair", ...s, relation: rel });
      bump(s.source.key);
      bump(s.target.key);
    }
  if (enabled("dibur-hamatchil"))
    for (const step of intermediateSteps(selected, byKey, relations, commentariesOn)) {
      if (seen.has(step.id)) continue;
      seen.add(step.id);
      steps.push(step);
      bump(step.source.key);
      bump(step.target.key);
    }
  const singles = (input.singleEngines ?? singleBookEngines()).filter(enabled);
  const info = (e: EngineId) => ENGINES.find((x) => x.id === e);
  for (const k of selected)
    for (const e of singles) {
      const b = byKey.get(k)!;
      steps.push({ id: `${e}|${k}`, kind: "single", engine: e, source: ref(b), why: `השיטה "${info(e)?.title ?? e}" קוראת כל ספר שנבחר ומקשרת אותו לכל ספר פתוח.` });
      bump(k);
    }

  const onBase = new Map<string, Relation[]>();
  for (const rs of relations.values()) for (const r of rs) pushTo(onBase, r.base.key, r);
  const books: PlanBookRow[] = selected.map((k) => {
    const b = byKey.get(k)!;
    const decisions: string[] = [];
    const all = relations.get(k) ?? [];
    const owns = all.filter((r) => r.kind !== "mishnah-in-talmud");
    const own = owns[0];
    if (own)
      decisions.push(
        own.kind === "notes" ? `ספר הערות על ${quote(own.base.title)} (${VIA_TEXT[own.via]}).` : `כתוב על ${owns.map((r) => quote(r.base.title)).join(", ")} (${VIA_TEXT[own.via]}).`,
        ...own.caveats,
      );
    for (const r of all) if (r.kind === "mishnah-in-talmud") decisions.push(...r.caveats);
    const onIt = onBase.get(k) ?? [];
    const comm = onIt.filter((r) => r.kind === "commentary");
    const notes = onIt.filter((r) => r.kind === "notes");
    if (comm.length) decisions.push(comm.length === 1 ? `פירוש פתוח אחד כתוב עליו: ${quote(comm[0]!.dependant.title)}.` : `${comm.length} פירושים פתוחים כתובים עליו.`);
    if (notes.length) decisions.push(notes.length === 1 ? `יש לו ספר הערות פתוח: ${quote(notes[0]!.dependant.title)}.` : `יש לו ${notes.length} ספרי הערות פתוחים.`);
    for (const r of onIt) if (r.kind === "mishnah-in-talmud") decisions.push(`המשנה ${quote(r.dependant.title)} מובאת בו, וקישוריה נבדקים לפי דיבור המתחיל.`);
    if (own && own.kind === "commentary" && (isTargum(b) || owns.some((r) => r.dependence === "targum")) && enabled("dibur-hamatchil")) decisions.push("זה תרגום: שורותיו אינן נפתחות בדיבור המתחיל, ולכן רק שיטת הכותרות רצה עליו.");
    const n = touches.get(k) ?? 0;
    let skipped: string | undefined;
    if (!n) skipped = all.length || onIt.length ? "השיטות המתאימות לספר הזה לא סומנו." : `${problems.get(k) ?? "לא נמצא לו קשר."} גם אין ספר פתוח שכתוב עליו.`;
    return { book: ref(b), decisions, steps: n, ...(skipped !== undefined && { skipped }) };
  });

  const perEngine: Partial<Record<EngineId, number>> = {};
  for (const s of steps) perEngine[s.engine] = (perEngine[s.engine] ?? 0) + 1;
  const identified = books.filter((r) => relations.has(r.book.key) || onBase.has(r.book.key)).length;
  return { steps, books, identified, perEngine };
}
