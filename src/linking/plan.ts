import { pushTo } from "../core/collections";
import type { BookRef } from "../core/links/model";
import { baseTitleKey, declaredBaseKey, isMergeableCompanionTitle, normalizeTitle, titleDeclaresDependencyOn } from "../core/links/titles";
import { ENGINES, type EngineId } from "./automatic";
import { pairOne, resolveBaseKey, titleIndex, type TitleIndex } from "./batch";

/*
 * The max-link planner ("קישור מרבי", stage 8.4): given the books the user selected and every open
 * book, decide which engine runs on which book or pair, and say why in Hebrew. Pure and synchronous —
 * the plan is shown for review before anything runs, and the worker only executes its steps.
 *
 * Relations, strongest evidence first:
 *   1. the database's own declaration (book_base_text, SourceBook.bases);
 *   2. the title: "X על Y" (the generator's rule, batch.ts) — and, before it, the notes-book patterns
 *      "הערות … על Y" / "הערות ל<Y>", which are footnotes companions, not commentaries.
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
}

export type RelationKind = "commentary" | "notes";
export type RelationVia = "base-text" | "title";

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
  const t = normalizeTitle(title);
  if (!t.startsWith(NOTES_PREFIX)) return null;
  const rest = t.slice(NOTES_PREFIX.length);
  if (rest && !/^\s/.test(rest)) return null; // "הערותיו", "הערותי…" are other words
  const named = declaredBaseKey(t);
  if (named) return named;
  const m = /^\s+ל(\S.*)$/.exec(rest);
  return m ? baseTitleKey(m[1]!) : null;
}

const isTargum = (b: PlanBook) => b.dependence?.toLowerCase() === "targum" || normalizeTitle(b.title).startsWith("תרגום");

const quote = (t: string) => `"${t}"`;

function ref(b: BookRef): BookRef {
  return { key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }) };
}

/** The relations a book has on its own (as a dependant: one, or one per base), or why it has none. */
export function relationsOf(book: PlanBook, byKey: ReadonlyMap<string, PlanBook>, index: TitleIndex): Relation[] | { problem: string } {
  const notesKey = notesBaseKey(book.title);
  const kind: RelationKind = notesKey !== null ? "notes" : "commentary";
  const titleKey = notesKey ?? declaredBaseKey(book.title);
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
  const r = kind === "notes" ? resolveBaseKey(titleKey, index, book) : (() => {
    const p = pairOne(book, index);
    return p.target ? { target: p.target } : { reason: p.reason ?? "" };
  })();
  if ("reason" in r) return { problem: r.reason };
  return [{ kind, dependant: ref(book), base: ref(r.target), via: "title", caveats }];
}

const VIA_TEXT: Record<RelationVia, string> = { "base-text": "לפי המסד", title: "לפי השם" };

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
  const asTargum = isTargum(depBook) && targumTypeOk(rel.dependant, rel.base);
  const out: { engine: PairEngineId; source: BookRef; target: BookRef; why: string; options?: Readonly<Record<string, unknown>> }[] = [
    {
      engine: "headings",
      source: rel.dependant,
      target: rel.base,
      why: `${d} כתוב על ${b} (${VIA_TEXT[rel.via]}). שיטת הכותרות מקשרת כל שורה בפירוש לפי הכותרות שמעליה (פרק ופסוק, סימן וסעיף, דף ועמוד).${asTargum ? " זה תרגום, ולכן הקישורים נכתבים מסוג \"תרגום\" (targum) ויוצגו באוצריא כתרגום." : ""}${tail}`,
      ...(asTargum && { options: { declaredType: "targum" } }),
    },
  ];
  if (!isTargum(depBook))
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
  for (const b of input.library) {
    const rs = relationsOf(b, byKey, index);
    if ("problem" in rs) {
      if (isSelected.has(b.key)) problems.set(b.key, rs.problem);
      continue;
    }
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
  const singles = (input.singleEngines ?? singleBookEngines()).filter(enabled);
  const info = (e: EngineId) => ENGINES.find((x) => x.id === e);
  for (const k of selected)
    for (const e of singles) {
      const b = byKey.get(k)!;
      steps.push({ id: `${e}|${k}`, kind: "single", engine: e, source: ref(b), why: `השיטה "${info(e)?.title ?? e}" קוראת כל ספר שנבחר ומקשרת אותו לכל ספר פתוח.` });
      bump(k);
    }

  const onBase = new Map<string, Relation[]>();
  for (const rs of relations.values()) for (const r of rs) pushTo(onBase, r.base.key, r); const books: PlanBookRow[] = selected.map((k) => {
    const b = byKey.get(k)!;
    const decisions: string[] = [];
    const owns = relations.get(k) ?? [];
    const own = owns[0];
    if (own)
      decisions.push(
        own.kind === "notes" ? `ספר הערות על ${quote(own.base.title)} (${VIA_TEXT[own.via]}).` : `כתוב על ${owns.map((r) => quote(r.base.title)).join(", ")} (${VIA_TEXT[own.via]}).`,
        ...own.caveats,
      );
    const onIt = onBase.get(k) ?? [];
    const comm = onIt.filter((r) => r.kind === "commentary");
    const notes = onIt.filter((r) => r.kind === "notes");
    if (comm.length) decisions.push(comm.length === 1 ? `פירוש פתוח אחד כתוב עליו: ${quote(comm[0]!.dependant.title)}.` : `${comm.length} פירושים פתוחים כתובים עליו.`);
    if (notes.length) decisions.push(notes.length === 1 ? `יש לו ספר הערות פתוח: ${quote(notes[0]!.dependant.title)}.` : `יש לו ${notes.length} ספרי הערות פתוחים.`);
    if (own && own.kind === "commentary" && isTargum(b) && enabled("dibur-hamatchil")) decisions.push("זה תרגום: שורותיו אינן נפתחות בדיבור המתחיל, ולכן רק שיטת הכותרות רצה עליו.");
    const n = touches.get(k) ?? 0;
    let skipped: string | undefined;
    if (!n) skipped = own || onIt.length ? "השיטות המתאימות לספר הזה לא סומנו." : `${problems.get(k) ?? "לא נמצא לו קשר."} גם אין ספר פתוח שכתוב עליו.`;
    return { book: ref(b), decisions, steps: n, ...(skipped !== undefined && { skipped }) };
  });

  const perEngine: Partial<Record<EngineId, number>> = {};
  for (const s of steps) perEngine[s.engine] = (perEngine[s.engine] ?? 0) + 1;
  const identified = books.filter((r) => relations.has(r.book.key) || onBase.has(r.book.key)).length;
  return { steps, books, identified, perEngine };
}
