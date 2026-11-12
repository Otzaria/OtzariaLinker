import { batch, computed, effect, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { SourceBook } from "../core/books";
import type { Link } from "../core/links/model";
import { baseTitleKey, declaredBaseTitle } from "../core/links/titles";
import { validateLink, type ValidationContext } from "../core/links/validate";
import type { EngineId } from "../linking/automatic";
import { notesBaseTitle, type MaxLinkPlan, type Relation } from "../linking/plan";
import { qaAction, redundantDuplicates, type QaCategory, type QaReport } from "../linking/qa";
import type { ExchangeState, ExportBundle } from "./exchange";
import type { LinkState } from "./history";
import type { MaxLinkScope, MaxLinkState } from "./maxlink";
import type { QualityState } from "./quality";
import type { InputFile, KeyValueStore, OpenedSource } from "./services";
import type { NoticeKind, Screen, SideTab } from "./store";
import type { SuggestMode } from "./router";
import type { SuggestionsState } from "./suggestions";

/*
 * The guided flow "link a folder (or several books) to Otzaria" (product audit, "איך זרימה מודרכת
 * צריכה להיראות"; route "#/guided/<step>"). Six screens one after the other — the books, what was
 * found in them, the Otzaria database only when a base is missing, the plan, the run and its review,
 * the check and the download — over the modules that already do the work: max-link plans and runs
 * (state/maxlink.ts, linking/plan.ts), suggestions are approved as usual (state/suggestions.ts), the
 * quality check and the export share validateExport (state/quality.ts, state/exchange.ts). Nothing
 * here plans, validates or exports by itself: it decides which step comes next, says in plain words
 * what the existing results mean, and remembers how far the user got (IndexedDB, next to autosave).
 *
 * The pure parts (step order and skipping, the book groups, the missing bases, the checks before the
 * run, the summary of the check) are exported functions with unit tests; GuidedFlowState wires them to
 * the store's signals.
 */

export const GUIDED_STEPS = ["files", "books", "db", "plan", "run", "finish"] as const;
export type GuidedStep = (typeof GUIDED_STEPS)[number];

/** The step names the screens and the progress line show. */
export const GUIDED_STEP_TITLES: Readonly<Record<GuidedStep, string>> = {
  files: "תיקייה או ספרים",
  books: "הספרים שנמצאו",
  db: "מסד אוצריא",
  plan: "התוכנית",
  run: "הרצה ואישור",
  finish: "בדיקה והורדה",
};

export const isGuidedStep = (s: unknown): s is GuidedStep => typeof s === "string" && (GUIDED_STEPS as readonly string[]).includes(s);

/* ---------------- step order ---------------- */

/** What decides which steps are open and which are skipped. */
export interface FlowFacts {
  /** books chosen in step 1 */
  books: number;
  /** base titles the books name that no open source has */
  missingBases: number;
  /** bases open in more than one source: the user may choose which edition */
  baseChoices: number;
  /** links in the project (approved suggestions, restored work) */
  links: number;
}

/** The database step is asked only when a base is missing, or when a base is open twice and the user may choose. */
export const dbStepNeeded = (f: FlowFacts): boolean => f.missingBases > 0 || f.baseChoices > 0;

/** Whether a step can be shown with what is open now. */
export function stepReady(step: GuidedStep, f: FlowFacts): boolean {
  if (step === "files") return true;
  if (step === "finish") return f.links > 0;
  return f.books > 0;
}

export const stepSkipped = (step: GuidedStep, f: FlowFacts): boolean => step === "db" && !dbStepNeeded(f);

/** The step "הבא" leads to, skipping what is not needed; null when the next one is not ready. */
export function nextStep(step: GuidedStep, f: FlowFacts): GuidedStep | null {
  for (let i = GUIDED_STEPS.indexOf(step) + 1; i < GUIDED_STEPS.length; i++) {
    const s = GUIDED_STEPS[i]!;
    if (stepSkipped(s, f)) continue;
    return stepReady(s, f) ? s : null;
  }
  return null;
}

/** The step "חזרה" leads to, skipping what was skipped on the way; null on the first. */
export function prevStep(step: GuidedStep, f: FlowFacts): GuidedStep | null {
  for (let i = GUIDED_STEPS.indexOf(step) - 1; i >= 0; i--) {
    const s = GUIDED_STEPS[i]!;
    if (!stepSkipped(s, f)) return s;
  }
  return null;
}

/** A step that still waits for the user: no books chosen, or a base missing that the database step asks for. */
export const stepWaits = (step: GuidedStep, f: FlowFacts): boolean => (step === "files" && f.books === 0) || (step === "db" && f.missingBases > 0);

/**
 * The step to show when `wanted` is asked for out of order (a reload, a continued flow, an address
 * typed by hand, Back): `wanted` itself when every step before it is done, else the first step on the
 * way that still waits for the user, else the furthest that can be shown.
 */
export function resolveStep(wanted: GuidedStep, f: FlowFacts): GuidedStep {
  let last: GuidedStep = "files";
  for (const s of GUIDED_STEPS) {
    if (stepSkipped(s, f)) {
      if (s === wanted) return last;
      continue;
    }
    if (!stepReady(s, f)) return last;
    if (s === wanted || stepWaits(s, f)) return s;
    last = s;
  }
  return last;
}

/* ---------------- what was found: the books, grouped ---------------- */

export interface BookGroup {
  id: string;
  tone: "ok" | "info" | "warn";
  /** one line that explains the group */
  text: string;
  books: { title: string; why?: string }[];
}

export interface MissingBase {
  /** the base title the books name */
  title: string;
  books: string[];
}

const q = (t: string) => `"${t}"`;

/** The relation each selected book is linked by as a dependant (a commentary, a notes book…), the main one first. */
function ownRelations(plan: MaxLinkPlan): Map<string, Relation> {
  const own = new Map<string, Relation>();
  for (const s of plan.steps) {
    if (s.kind !== "pair") continue;
    const r = s.relation;
    const cur = own.get(r.dependant.key);
    // the relation to its own base wins over the extra pair with an intermediate commentator (plan.ts intermediateSteps)
    if (!cur || ((cur.dhOnly || cur.through) && !r.dhOnly && !r.through)) own.set(r.dependant.key, r);
  }
  return own;
}

/**
 * The bases the selected books name (by "X על Y" or "הערות על Y") that are not open in any source:
 * what the Otzaria database is needed for. `openTitleKeys`: baseTitleKey of every open book.
 */
export function missingBases(plan: MaxLinkPlan, openTitleKeys: ReadonlySet<string>): MissingBase[] {
  const own = ownRelations(plan);
  const out = new Map<string, string[]>();
  for (const row of plan.books) {
    if (own.has(row.book.key)) continue;
    const named = notesBaseTitle(row.book.title) ?? declaredBaseTitle(row.book.title);
    if (named === null || openTitleKeys.has(baseTitleKey(named))) continue;
    out.set(named, [...(out.get(named) ?? []), row.book.title]);
  }
  return [...out].map(([title, books]) => ({ title, books }));
}

const KIND_TEXT: Record<Relation["kind"], (n: number, one: string, base: string) => string> = {
  commentary: (n, one, base) => (n === 1 ? `${q(one)} — פירוש על ${q(base)}` : `${n.toLocaleString("he")} פירושים על ${q(base)}`),
  notes: (n, one, base) => (n === 1 ? `${q(one)} — ספר הערות, והספר שעליו נכתב: ${q(base)}` : `${n.toLocaleString("he")} ספרי הערות על ${q(base)}`),
  "mishnah-in-talmud": (n, one, base) => (n === 1 ? `${q(one)} — משנה שמובאת ב־${q(base)}` : `${n.toLocaleString("he")} מסכתות משנה מול הגמרא שלהן`),
};

/**
 * The selected books as the user should read them (product audit, step 2): one line per group —
 * "300 פירושים על 'בראשית'", "ספר הערות והספר שלו", "3 ספרים בלי קשר — למה" — from the planner's own
 * relations and reasons (linking/plan.ts), never a second guess.
 */
export function groupBooks(plan: MaxLinkPlan, missing: readonly MissingBase[] = []): BookGroup[] {
  const own = ownRelations(plan);
  const bases = new Set<string>();
  for (const r of own.values()) bases.add(r.base.key);
  const missingOf = new Map<string, string>();
  for (const m of missing) for (const b of m.books) missingOf.set(b, m.title);

  const related = new Map<string, { kind: Relation["kind"]; base: string; books: { title: string; why?: string }[] }>();
  const baseRows: { title: string }[] = [];
  const single: { title: string; why?: string }[] = [];
  const none: { title: string; why?: string }[] = [];
  const lacking = new Map<string, string[]>();
  for (const row of plan.books) {
    const t = row.book.title;
    const r = own.get(row.book.key);
    if (r) {
      const id = `${r.kind}|${r.base.title}`;
      const g = related.get(id) ?? { kind: r.kind, base: r.base.title, books: [] };
      g.books.push({ title: t });
      related.set(id, g);
    } else if (missingOf.has(t)) lacking.set(missingOf.get(t)!, [...(lacking.get(missingOf.get(t)!) ?? []), t]);
    else if (bases.has(row.book.key)) baseRows.push({ title: t });
    else if (row.skipped) none.push({ title: t, why: row.skipped });
    else single.push({ title: t, ...(row.unpaired && { why: row.unpaired }) });
  }

  const out: BookGroup[] = [...related]
    .sort((a, b) => b[1].books.length - a[1].books.length)
    .map(([id, g]) => ({ id, tone: "ok", text: KIND_TEXT[g.kind](g.books.length, g.books[0]!.title, g.base), books: g.books }));
  if (baseRows.length)
    out.push({
      id: "bases",
      tone: "info",
      text: baseRows.length === 1 ? `${q(baseRows[0]!.title)} — ספר בסיס: ספרים אחרים כאן כתובים עליו` : `${baseRows.length.toLocaleString("he")} ספרי בסיס שספרים אחרים כאן כתובים עליהם`,
      books: baseRows,
    });
  for (const [title, books] of lacking)
    out.push({
      id: `missing|${title}`,
      tone: "warn",
      text: `${books.length === 1 ? q(books[0]!) : `${books.length.toLocaleString("he")} ספרים`} כתוב${books.length === 1 ? "" : "ים"} על ${q(title)}, שאינו בין הספרים שבחרתם — צריך אותו ממסד אוצריא`,
      books: books.map((b) => ({ title: b })),
    });
  if (single.length)
    out.push({
      id: "single",
      tone: "info",
      text: `${single.length === 1 ? q(single[0]!.title) : `${single.length.toLocaleString("he")} ספרים`} בלי ספר בסיס: ${single.length === 1 ? "ייבדק" : "ייבדקו"} רק למראי מקומות לספרים אחרים`,
      books: single,
    });
  if (none.length) out.push({ id: "none", tone: "warn", text: `${none.length === 1 ? "ספר אחד" : `${none.length.toLocaleString("he")} ספרים`} בלי קשר — למה:`, books: none });
  return out;
}

/* ---------------- what the export will refuse, known before the run ---------------- */

export interface PreflightIssue {
  code: string;
  /** what will happen and why, in plain words */
  text: string;
  /** the books whose links it concerns */
  books: string[];
  /** the choice that releases them: export for the user's own use */
  fix?: "private";
}

/** Rules about the two BOOKS of a link, whatever lines the run finds: the export would refuse every link of such a pair. */
const PREFLIGHT_CODES = new Set(["sefaria/not-library-edition", "sefaria/both-sides", "export/sefaria-both", "export/unsafe-title"]);

/**
 * The export's own rules (core/links/validate.ts validateLink, with the store's context: the library
 * edition, the purpose) on the SHAPE of every planned pair — one line on each side, no anchor — so the
 * problems the export would raise for every link of a pair are said before anything runs (product
 * audit, step 4). Rules about lines, anchors and ranges are left out: only the run knows them.
 */
export function exportPreflight(plan: MaxLinkPlan, ctx: ValidationContext): PreflightIssue[] {
  const books: ValidationContext = { ...ctx, line: () => undefined, lineCount: () => undefined };
  delete books.existing;
  delete books.linksFile;
  delete books.libraryMayHaveFile;
  const groups = new Map<string, PreflightIssue & { set: Set<string> }>();
  const add = (key: string, code: string, text: string, book: string, fix?: "private") => {
    const g = groups.get(key) ?? { code, text, books: [], set: new Set<string>(), ...(fix && { fix }) };
    if (!g.set.has(book)) (g.set.add(book), g.books.push(book));
    groups.set(key, g);
  };
  for (const s of plan.steps) {
    if (s.kind !== "pair") continue;
    const link: Link = { id: "preflight", status: "new", provenance: "auto", source: { book: s.source, line: 0 }, target: { book: s.target, line: 0 }, declaredType: "commentary", heRef2: "-" };
    const dependant = s.relation.dependant.title;
    for (const p of validateLink(link, books)) {
      if (p.severity !== "error" || !PREFLIGHT_CODES.has(p.code)) continue;
      if (p.code === "sefaria/not-library-edition") {
        // which side is the user's own book that bears a library Sefaria name — the context's own answer
        for (const b of [s.source, s.target])
          if (books.sefariaTitle?.(b) && !books.sefariaOwned?.(b))
            add(`${p.code}|${b.title}`, p.code, `קישורים אל ${q(b.title)} לא יוכלו להישלח לספריית אוצריא: ${q(b.title)} שבחרתם הוא ספר שלכם, ובספרייה השם הזה שייך לספר אחר (של ספריא). לשימוש שלכם הם ייצאו כרגיל.`, dependant, "private");
      } else if (p.code === "export/unsafe-title") add(`${p.code}|${s.source.title}`, p.code, `אי אפשר לכתוב קובץ קישורים בשם ${q(s.source.title)}. שנו את שם הקובץ ופתחו אותו שוב.`, s.source.title);
      else add(`both|${s.source.title}|${s.target.title}`, "sefaria/both-sides", `${q(s.source.title)} ו־${q(s.target.title)} הם שניהם ספרים שהספרייה מקבלת מספריא, והיא לא מקבלת קישור ביניהם מקובץ.`, dependant);
    }
  }
  return [...groups.values()].map(({ set: _s, ...g }) => g);
}

/* ---------------- time ---------------- */

/**
 * A rough estimate of a max-link run, from the product audit's measurements: 1,200 steps in 16–19
 * seconds on the database slice (≈15 ms a step), 1,800 steps in 6 minutes against the real database
 * with 8,154 books (≈200 ms a step, reading the large books and their links).
 */
export function estimateRunMs(steps: number, openBooks: number): number {
  return 1000 + steps * (openBooks > 2000 ? 200 : 15);
}

/** "כ־20 שניות", "כ־6 דקות", "פחות מ־5 שניות". */
export function durationText(ms: number): string {
  if (ms < 5_000) return "פחות מ־5 שניות";
  if (ms < 60_000) return `כ־${(Math.round(ms / 5_000) * 5).toLocaleString("he")} שניות`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return min === 1 ? "כדקה" : `כ־${min.toLocaleString("he")} דקות`;
  const h = Math.round(ms / 3_600_000);
  return h === 1 ? "כשעה" : `כ־${h.toLocaleString("he")} שעות`;
}

/* ---------------- the check, in short ---------------- */

export type IssueAction = "private" | "drop-anchor" | "delete-duplicates" | "workspace";

export interface IssueGroup {
  category: QaCategory;
  severity: "error" | "warning";
  count: number;
  text: string;
  action: IssueAction;
  /** the links the action applies to (drop-anchor, delete-duplicates) */
  ids: string[];
}

/** What each kind of problem means to the user, without the file format's names. */
const ISSUE_TEXT: Readonly<Record<QaCategory, string>> = {
  duplicate: "קישורים כפולים",
  "missing-book": "קישורים לספר שלא נמצא באף מקור פתוח",
  "out-of-range": "קישורים לשורה שאינה בספר",
  heading: "קישורים לשורת כותרת, שאוצריא מדלגת עליהם",
  anchor: "סימון מילים שאוצריא לא תשמור כמו שהוא",
  type: "סוג קשר שאוצריא תשמור אחרת",
  sefaria: "קישורים לספרים של ספריא שהספרייה לא תקבל כמו שהם",
  title: "שם ספר שאוצריא משנה או ממזגת",
  reference: "קישורים בלי שם מקום",
  unverified: "שורות שעוד לא נבדקו",
  "in-db": "קישורים שכבר קיימים באוצריא",
  "db-copy": "קישורים שהועתקו מהמסד",
  "library-file": "ספרים שכבר יש להם קובץ קישורים בספרייה",
  other: "בעיות אחרות",
};

export const ISSUE_ACTION_LABEL: Readonly<Record<IssueAction, string>> = {
  private: "לשימוש שלי בלבד",
  "drop-anchor": "הסרת סימון המילים",
  "delete-duplicates": "מחיקת הכפולים",
  workspace: "פתיחה בבדיקה המלאה",
};

/**
 * The quality report (linking/qa.ts — the export's rules) as a short list: one line per kind of
 * problem and severity, with the one action that fixes it when there is one (the same remedies as
 * the check tab: qaAction, redundantDuplicates), or the full check in the workspace. Info is left out.
 */
export function summarizeQa(report: QaReport, purpose: "submission" | "private"): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  const dups = new Set(redundantDuplicates(report));
  for (const i of report.issues) {
    const sev = i.problem.severity;
    if (sev === "info") continue;
    const key = `${sev}|${i.category}`;
    const g = groups.get(key) ?? { category: i.category, severity: sev, count: 0, text: ISSUE_TEXT[i.category], action: "workspace" as IssueAction, ids: [] };
    g.count++;
    const act = qaAction(i.problem, purpose);
    if (act === "private") g.action = "private";
    else if (act === "drop-anchor" && g.action !== "private") (g.action = "drop-anchor"), g.ids.push(i.link.id);
    else if (dups.has(i.link.id) && g.action === "workspace") (g.action = "delete-duplicates"), g.ids.push(i.link.id);
    else if (dups.has(i.link.id) && g.action === "delete-duplicates") g.ids.push(i.link.id);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === "error" ? -1 : 1));
}

/* ---------------- persistence ---------------- */

/** How far a flow got, kept in the browser (IndexedDB) so a reload or a closed tab can continue it. */
export interface GuidedRecord {
  v: 1;
  step: GuidedStep;
  /** the books' sources, to open again (the browser cannot reopen files by itself) */
  sources: { label: string; kind: string; books: number; files?: string[] }[];
  purpose: "submission" | "private";
  /** the label of the source chosen for the bases, when a base is open twice */
  preferBase?: string;
  links: number;
  /** the result was downloaded: nothing to continue */
  done: boolean;
  savedAt: number;
}

export const GUIDED_KEY = "guided:v1";

export function parseGuidedRecord(text: string | null | undefined): GuidedRecord | null {
  if (!text) return null;
  try {
    const r = JSON.parse(text) as Partial<GuidedRecord>;
    if (r?.v !== 1 || !isGuidedStep(r.step) || !Array.isArray(r.sources)) return null;
    const sources = r.sources
      .filter((s): s is GuidedRecord["sources"][number] => !!s && typeof s.label === "string")
      .map((s) => ({ label: s.label, kind: String(s.kind ?? ""), books: Number(s.books) || 0, ...(Array.isArray(s.files) && { files: s.files.filter((f): f is string => typeof f === "string").slice(0, 50) }) }));
    return {
      v: 1,
      step: r.step,
      sources,
      purpose: r.purpose === "private" ? "private" : "submission",
      ...(typeof r.preferBase === "string" && r.preferBase && { preferBase: r.preferBase }),
      links: Number(r.links) || 0,
      done: r.done === true,
      savedAt: Number(r.savedAt) || 0,
    };
  } catch {
    return null;
  }
}

/* ---------------- the flow ---------------- */

/** What the flow reads and calls in the store (AppStore satisfies it). */
export interface GuidedHost {
  readonly screen: Signal<Screen>;
  readonly sideTab: Signal<SideTab>;
  readonly suggestMode: Signal<SuggestMode>;
  readonly intent: Signal<{ engine?: EngineId; sourceId?: string; allBooks?: boolean } | null>;
  readonly sources: ReadonlySignal<OpenedSource[]>;
  readonly books: ReadonlySignal<Map<string, SourceBook>>;
  readonly linkState: ReadonlySignal<LinkState>;
  readonly exportPurpose: Signal<"submission" | "private">;
  readonly recovery: Signal<{ links: number; restore: () => void; dismiss: () => void } | null>;
  readonly maxLink: Pick<MaxLinkState, "plan" | "run" | "report" | "scopeLabel">;
  readonly suggestions: Pick<SuggestionsState, "run" | "approve" | "pendingAtLeast" | "show" | "state">;
  readonly quality: Pick<QualityState, "run" | "report">;
  readonly exchange: Pick<ExchangeState, "prepareExport" | "saveExport">;
  openFiles(files: InputFile[]): Promise<void>;
  validation(): ValidationContext;
  isLibrarySource(sourceId: string): boolean;
  deleteLinks(ids: readonly string[]): void;
  dropAnchors(ids: readonly string[]): void;
  notify(kind: NoticeKind, text: string, details?: string[]): void;
}

export class GuidedFlowState {
  readonly step = signal<GuidedStep>("files");
  /** a flow was started (or continued) in this session: the workspace offers the way back to it */
  readonly active = signal(false);
  /** the sources opened in step 1: the books to link */
  readonly bookSources = signal<readonly string[]>([]);
  /** the source whose books are the bases when a base is open in several ("" = the planner's default) */
  readonly preferSource = signal("");
  /** a flow an earlier session left unfinished, offered on the home screen and in step 1 */
  readonly saved = signal<GuidedRecord | null>(null);
  /** where a continued flow had got to: step 1 leads back there once its books are open again */
  readonly resumeTo = signal<GuidedStep | null>(null);
  /** the export as the last check made it (step 6), and the link revision and purpose it was made for */
  readonly bundle = signal<ExportBundle | null>(null);
  private readonly bundleFor = signal<{ revision: number; purpose: string } | null>(null);
  readonly checking = signal(false);
  /** what was downloaded: the last step shows "what now?" */
  readonly downloaded = signal<string | null>(null);
  /** the preferred base source of a continued flow, by label, until its source is open again */
  private preferLabel: string | undefined;

  /** the books of step 1 */
  readonly scope = computed<MaxLinkScope | null>(() => {
    const open = new Set(this.host.sources.value.map((s) => s.info.id));
    const ids = this.bookSources.value.filter((id) => open.has(id));
    return ids.length ? { kind: "sources", ids } : null;
  });

  /** the max-link plan of the books (linking/plan.ts), with the chosen bases */
  readonly plan = computed<MaxLinkPlan | null>(() => {
    const scope = this.scope.value;
    if (!scope) return null;
    const prefer = this.preferSource.value || (this.preferLabel ? this.host.sources.value.find((s) => s.info.label === this.preferLabel)?.info.id : undefined);
    return this.host.maxLink.plan(scope, undefined, prefer || undefined);
  });

  readonly missing = computed<MissingBase[]>(() => {
    const plan = this.plan.value;
    if (!plan) return [];
    const keys = new Set<string>();
    for (const b of this.host.books.value.values()) keys.add(baseTitleKey(b.title));
    return missingBases(plan, keys);
  });

  readonly groups = computed<BookGroup[]>(() => {
    const plan = this.plan.value;
    return plan ? groupBooks(plan, this.missing.value) : [];
  });

  readonly facts = computed<FlowFacts>(() => {
    let links = 0;
    for (const l of this.host.linkState.value.links.values()) if (l.status !== "deleted" && l.provenance !== "db") links++;
    return { books: this.plan.value?.books.length ?? 0, missingBases: this.missing.value.length, baseChoices: this.plan.value?.baseSources.length ?? 0, links };
  });

  /** the export's problems known before the run, for the purpose chosen now */
  readonly preflight = computed<PreflightIssue[]>(() => {
    const plan = this.plan.value;
    return plan ? exportPreflight(plan, this.host.validation()) : [];
  });

  readonly estimateMs = computed(() => estimateRunMs(this.plan.value?.steps.length ?? 0, this.host.books.value.size));

  /** the sources that are not the books: the database and anything else that holds bases */
  readonly otherSources = computed(() => this.host.sources.value.filter((s) => !this.bookSources.value.includes(s.info.id)));

  /** the current suggestions run is this flow's max-link run */
  readonly ran = computed(() => !!this.host.suggestions.run.value?.maxlink);

  /** the check of step 6, in short */
  readonly issues = computed<IssueGroup[]>(() => {
    const r = this.host.quality.report.value;
    return r ? summarizeQa(r, this.host.exportPurpose.value) : [];
  });

  /** the check and the export plan no longer match the links or the purpose */
  readonly stale = computed(() => {
    const f = this.bundleFor.value;
    return !f || f.revision !== this.host.linkState.value.revision || f.purpose !== this.host.exportPurpose.value;
  });

  constructor(private readonly host: GuidedHost) {}

  /** Starts a new flow (the home task card). Books already open from a non-library source count as chosen. */
  start(): void {
    const adopt = this.host.sources.peek().filter((s) => this.isBooksSource(s)).map((s) => s.info.id);
    batch(() => {
      this.bookSources.value = adopt;
      this.preferSource.value = "";
      this.preferLabel = undefined;
      this.resumeTo.value = null;
      this.saved.value = null;
      this.bundle.value = null;
      this.bundleFor.value = null;
      this.downloaded.value = null;
      this.active.value = true;
      this.step.value = adopt.length ? "books" : "files";
      this.host.screen.value = "guided";
    });
  }

  /** The route asked for a step ("#/guided/plan"): the furthest that can be shown now. */
  show(step?: string): void {
    batch(() => {
      this.active.value = true;
      this.step.value = resolveStep(isGuidedStep(step) ? step : this.step.peek(), this.facts.peek());
      this.host.screen.value = "guided";
    });
  }

  /** Continues a flow an earlier session left: its links come back (autosave), and step 1 asks for its books again. */
  continueSaved(): void {
    const r = this.saved.peek();
    if (!r) return;
    this.host.recovery.peek()?.restore();
    batch(() => {
      this.host.exportPurpose.value = r.purpose;
      this.preferLabel = r.preferBase;
      this.bookSources.value = [];
      this.resumeTo.value = r.step;
      this.active.value = true;
      this.step.value = "files";
      this.host.screen.value = "guided";
    });
  }

  dismissSaved(): void {
    this.saved.value = null;
    this.resumeTo.value = null;
  }

  /** A text or personal source holds books to link; the official database holds bases. */
  private isBooksSource(s: OpenedSource): boolean {
    return !(s.info.kind === "otzaria-db" && this.host.isLibrarySource(s.info.id));
  }

  /** Step 1: opens the books (the existing opening and classification). The official database, if picked too, serves the bases. */
  async addBooks(files: InputFile[]): Promise<number> {
    const before = new Set(this.host.sources.peek().map((s) => s.info.id));
    await this.host.openFiles(files);
    const added = this.host.sources.peek().filter((s) => !before.has(s.info.id) && this.isBooksSource(s)).map((s) => s.info.id);
    if (added.length) this.bookSources.value = [...this.bookSources.peek(), ...added];
    return added.length;
  }

  /** Step 3: opens the Otzaria database (or any source with the bases). */
  async addBases(files: InputFile[]): Promise<void> {
    await this.host.openFiles(files);
  }

  /** Drops a source from the books (it stays open, and may still serve as bases). */
  removeBooks(sourceId: string): void {
    this.bookSources.value = this.bookSources.peek().filter((id) => id !== sourceId);
  }

  setPreferSource(id: string): void {
    this.preferLabel = undefined;
    this.preferSource.value = id;
  }

  next(): void {
    const n = nextStep(this.step.peek(), this.facts.peek());
    if (n) this.step.value = n;
  }

  back(): void {
    const p = prevStep(this.step.peek(), this.facts.peek());
    if (p) this.step.value = p;
  }

  /** Step 1 of a continued flow: back to where it was, once its books are open again. */
  resume(): void {
    const to = this.resumeTo.peek();
    batch(() => {
      this.resumeTo.value = null;
      this.saved.value = null;
      if (to) this.step.value = resolveStep(to, this.facts.peek());
    });
  }

  /** Step 4 → 5: runs the plan (max-link), then shows its result. */
  async run(): Promise<boolean> {
    const plan = this.plan.peek();
    const scope = this.scope.peek();
    if (!plan || !scope) return false;
    this.step.value = "run";
    return this.host.maxLink.run(plan, this.host.maxLink.scopeLabel(scope));
  }

  /** "Approve all N certain" (the same action as the suggestions table's button). */
  approveCertain(): number {
    return this.host.suggestions.approve(this.host.suggestions.pendingAtLeast("certain"));
  }

  /** The suggestions that need a look: pending and not certain, in the run's order. */
  toReview(): string[] {
    const certain = new Set(this.host.suggestions.pendingAtLeast("certain"));
    return this.host.suggestions.pendingAtLeast("none").filter((id) => !certain.has(id));
  }

  /**
   * Step 6: the export plan (it fills the Sefaria references it can first, as the export does), then
   * the quality check on the same links — the two share validateExport, so they agree.
   */
  async check(): Promise<void> {
    if (this.checking.peek()) return;
    this.checking.value = true;
    try {
      const bundle = await this.host.exchange.prepareExport();
      if (!bundle) return;
      await this.host.quality.run();
      batch(() => {
        this.bundle.value = bundle;
        this.bundleFor.value = { revision: this.host.linkState.peek().revision, purpose: this.host.exportPurpose.peek() };
      });
    } finally {
      this.checking.value = false;
    }
  }

  /** The one action of a group of problems, then the check again. */
  async remedy(g: IssueGroup): Promise<void> {
    if (g.action === "workspace") return this.openWorkspace();
    if (g.action === "private") this.host.exportPurpose.value = "private";
    else if (g.action === "drop-anchor") this.host.dropAnchors(g.ids);
    else if (g.action === "delete-duplicates") this.host.deleteLinks(g.ids);
    this.downloaded.value = null;
    await this.check();
  }

  setPurpose(p: "submission" | "private"): void {
    this.host.exportPurpose.value = p;
    this.downloaded.value = null;
  }

  /** Downloads the export as it was checked. */
  download(): boolean {
    const b = this.bundle.peek();
    if (!b || this.stale.peek()) return false;
    const files = b.files.length + b.altToc.files.length;
    if (!files) return false;
    this.host.exchange.saveExport(b);
    this.downloaded.value = files > 1 ? `ירד קובץ ZIP עם ${files.toLocaleString("he")} קבצים ודוח.` : "הקובץ ירד.";
    return true;
  }

  /** The way out to manual work at any step: the workspace, at the place that does what this step does. */
  openWorkspace(): void {
    const step = this.step.peek();
    batch(() => {
      if (step === "finish") this.host.sideTab.value = "qa";
      else {
        this.host.sideTab.value = "suggestions";
        if (!this.ran.peek() || step !== "run") {
          this.host.suggestMode.value = "maxlink";
          const sourceId = this.bookSources.peek()[0];
          this.host.intent.value = sourceId ? { sourceId } : null;
        }
      }
      this.host.screen.value = "workspace";
    });
  }

  /** The record of how far the flow got (a continued flow keeps the books it still waits for). */
  record(): GuidedRecord {
    const ids = this.bookSources.value;
    const open = this.host.sources.value.filter((s) => ids.includes(s.info.id));
    const prev = this.saved.peek();
    const sources = open.length
      ? open.map((s) => {
          const files = s.info.kind === "text-files" ? s.books.flatMap((b) => (b.path ? [b.path] : [])).slice(0, 50) : [];
          return { label: s.info.label, kind: s.info.kind, books: s.books.length, ...(files.length && { files }) };
        })
      : (prev?.sources ?? []);
    const prefer = this.preferSource.value ? this.host.sources.value.find((s) => s.info.id === this.preferSource.value)?.info.label : this.preferLabel;
    // a flow waiting for its books again keeps the step it had reached
    const waiting = open.length ? undefined : (this.resumeTo.value ?? prev?.step);
    return {
      v: 1,
      step: waiting ?? this.step.value,
      sources,
      purpose: this.host.exportPurpose.value,
      ...(prefer && { preferBase: prefer }),
      links: this.facts.value.links,
      done: this.downloaded.value !== null,
      savedAt: Date.now(),
    };
  }

  /**
   * Keeps the record in the browser a moment after every change while a flow is active, and offers an
   * unfinished one from an earlier session (next to the autosave of the links, AppStore.startAutosave).
   */
  startPersist(kv: KeyValueStore, delayMs = 500): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    void kv.get(GUIDED_KEY).then(
      (text) => {
        const r = parseGuidedRecord(text);
        // also when the address reopened the flow itself (a reload on "#/guided/…"): nothing is chosen yet
        if (r && !r.done && r.sources.length && !this.bookSources.peek().length) this.saved.value = r;
      },
      () => {},
    );
    const stop = effect(() => {
      if (!this.active.value) return;
      const rec = this.record();
      // nothing chosen yet: nothing to continue (and an unread record from before must not be overwritten)
      if (!rec.sources.length) return;
      const text = JSON.stringify(rec);
      clearTimeout(timer);
      timer = setTimeout(() => void kv.set(GUIDED_KEY, text).catch(() => {}), delayMs);
    });
    return () => (clearTimeout(timer), stop());
  }
}
