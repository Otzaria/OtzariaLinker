import { pushTo } from "../core/collections";
import { batch, computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import { sourceIdOfBookKey, type SourceBook } from "../core/books";
import type { BookRef } from "../core/links/model";
import type { EngineId, Reason } from "../linking/automatic";
import { bookFingerprint, failBook, fingerprintKeys, finishBook, jobCsv, jobFromPlan, jobTotals, parseBookResult, parseJobRecord, runOrder, stableId, stepsByBook, withStableIds, type BookResult, type JobBook, type JobRecord, type JobState, type StoredStep } from "../linking/batch-job";
import { buildReport, MAXLINK_PROGRESS_UNIT, reportCsv, type MaxLinkJobResult, type MaxLinkReport, type MaxLinkRunInfo, type StepOutcome } from "../linking/maxlink-report";
import { applyPairMinimums, linePairKey, mergeSuggestions, type MergedSuggestion, type MergeItem } from "../linking/merge";
import type { TitleFitReport } from "../linking/title-fit";
import { competingTargets, evidenceFromCounts, evidenceToFollow, linkedFields, linkedProps, PAIR_ENGINES, pairMethodKey, planMaxLink, type LinkedEvidence, type MaxLinkPlan, type PairEngineId, type PlanBook, type PlanChoices, type PlanStep, type RelationKind } from "../linking/plan";
import type { LinkState } from "./history";
import type { BooksService, CallOptions, KeyValueStore, OpenedSource, Saver } from "./services";
import type { NoticeKind, SideTab } from "./store";
import type { SuggestionsState } from "./suggestions";
import { countOf } from "./task-progress";

/*
 * Max-link ("קישור מרבי", stage 8.4) in the state layer: plan a selection (linking/plan.ts), run the
 * plan's steps in the worker, merge everything into ONE suggestions run (linking/merge.ts), and keep
 * the report. The run is an ordinary SuggestionRun, so the table, inline and card views, approve,
 * reject and undo work on it unchanged. Kept out of store.ts on purpose, like AltTocState.
 */
export type MaxLinkScope =
  | { kind: "book"; key: string }
  | { kind: "source"; id: string }
  | { kind: "sources"; ids: readonly string[] }
  /** exactly these books (issue #26: 2-3 or any subset), in this order; keys of books that are not open are ignored */
  | { kind: "books"; keys: readonly string[] }
  | { kind: "all" };

export interface MaxLinkHost {
  readonly books: ReadonlySignal<Map<string, SourceBook>>;
  readonly sources: ReadonlySignal<OpenedSource[]>;
  readonly linkState: Signal<LinkState>;
  /** the run, its state and the shown suggestion: a max-link run is an ordinary suggestions run */
  readonly suggestions: Pick<SuggestionsState, "run" | "dbLinkKeys" | "current" | "state">;
  readonly sideTab: Signal<SideTab>;
  refOf(bookKey: string): BookRef;
  notify(kind: NoticeKind, text: string, details?: string[]): void;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>, count?: (done: number, total: number) => string): Promise<T | null>;
  /** keys of the open books the library treats as Sefaria's (AppStore.sefariaOwnedKeys): the engines' answer to it */
  sefariaOwnedKeys?(): string[];
}

export interface MaxLinkRunOptions {
  /** per-engine options (advanced mode) */
  engineOptions?: Partial<Record<EngineId, Record<string, unknown>>>;
  /** the source the plan took the bases from when a base is open in several: a resumed job plans the same */
  preferSource?: string;
}


/** Where the batch job is kept in the browser: the record, and each book's result under its index. */
export const JOB_KEY = "maxlink-job:v1";
const resultKey = (id: string, i: number) => `${JOB_KEY}:${id}:${i}`;
/** units of the job's progress per book: the worker reports inside a book */
const UNIT = MAXLINK_PROGRESS_UNIT;

const withoutWhy = ({ why: _w, ...b }: JobBook): JobBook => b;

/** " ספר אחד נעצר באמצע…": the books stopped while they ran, whose suggestions are shown as partial; "" when none. */
function partialText(job: JobRecord): string {
  const cut = job.books.filter((b) => b.status === "pending" && b.partial);
  if (!cut.length) return "";
  const n = cut.reduce((s, b) => s + b.partial!, 0).toLocaleString("he");
  return cut.length === 1
    ? ` "${cut[0]!.title}" נעצר באמצע: ${n} ההצעות שנמצאו בו עד העצירה מוצגות, והן חלקיות — "המשך" מריץ אותו שוב מההתחלה.`
    : ` ${cut.length.toLocaleString("he")} ספרים נעצרו באמצע: ${n} ההצעות שנמצאו בהם עד העצירה מוצגות, והן חלקיות — "המשך" מריץ אותם שוב מההתחלה.`;
}

/**
 * Binds the book refs inside a stored result to this session's books by title (BookRef: key, title,
 * origin). A title that is not open keeps its old key: it names no open book.
 */
function rebind(v: unknown, keyOf: (title: string) => string | undefined): void {
  if (Array.isArray(v)) for (const x of v) rebind(x, keyOf);
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.key === "string" && typeof o.title === "string" && typeof o.origin === "string") o.key = keyOf(o.title) ?? o.key;
    for (const x of Object.values(o)) if (x && typeof x === "object") rebind(x, keyOf);
  }
}

/**
 * How many selected books the evidence pass reads (one link summary each, from the link table's book
 * indexes: a base book with 200K links takes seconds). Beyond it the plan goes by declarations and
 * titles alone, and says so.
 */
export const EVIDENCE_BOOKS = 200;
/** Up to this many unread books the max-link form reads them by itself; more wait for the user's click. */
export const AUTO_EVIDENCE_BOOKS = 20;

export class MaxLinkState {
  /**
   * The existing-links evidence (linking/plan.ts, PlanBook.linkedBases / linkedKinds): dependant key →
   * the pairs the database links it in as their commentary, translation or midrash. Grows as books are
   * checked; kept for the session.
   */
  readonly evidence = signal<ReadonlyMap<string, readonly LinkedEvidence[]>>(new Map());
  /** books whose link summary was read; `checkedCount` changes with it, for the views */
  private readonly checked = new Set<string>();
  readonly checkedCount = signal(0);
  /** selected books the last evidence pass left unread (over EVIDENCE_BOOKS) */
  readonly unchecked = signal(0);

  /** the report of the current run, live: approvals, rejections and undo update it */
  readonly report = computed<MaxLinkReport | null>(() => {
    const run = this.host.suggestions.run.value;
    if (!run?.maxlink) return null;
    const st = this.host.suggestions.state.value;
    return buildReport(run.maxlink, run.result.suggestions as readonly MergedSuggestion[], (id) => st.get(id));
  });

  constructor(
    private readonly host: MaxLinkHost,
    private readonly service: BooksService,
    private readonly saver: Saver,
  ) {}

  /** The keys of the books a scope selects. */
  selection(scope: MaxLinkScope): string[] {
    if (scope.kind === "book") return this.host.books.value.has(scope.key) ? [scope.key] : [];
    if (scope.kind === "source") return this.host.sources.value.find((s) => s.info.id === scope.id)?.books.map((b) => b.key) ?? [];
    if (scope.kind === "books") return scope.keys.filter((k, i) => this.host.books.value.has(k) && scope.keys.indexOf(k) === i);
    // several sources (the guided flow's folder, opened in more than one pick), in the order they were opened
    if (scope.kind === "sources") return this.host.sources.value.filter((s) => scope.ids.includes(s.info.id)).flatMap((s) => s.books.map((b) => b.key));
    return [...this.host.books.value.keys()];
  }

  scopeLabel(scope: MaxLinkScope): string {
    if (scope.kind === "book") return `הספר "${this.host.refOf(scope.key).title}"`;
    if (scope.kind === "source") return `המקור "${this.host.sources.value.find((s) => s.info.id === scope.id)?.info.label ?? scope.id}"`;
    if (scope.kind === "books") {
      const titles = this.selection(scope).map((k) => `"${this.host.refOf(k).title}"`);
      return titles.length === 1 ? `הספר ${titles[0]}` : `הספרים ${titles.join(", ")}`;
    }
    if (scope.kind === "sources") {
      const labels = this.host.sources.value.filter((s) => scope.ids.includes(s.info.id)).map((s) => `"${s.info.label}"`);
      return labels.length === 1 ? `המקור ${labels[0]}` : `המקורות ${labels.join(", ")}`;
    }
    return "כל הספרים הפתוחים";
  }

  /** The selected database books whose links were not read yet (none when the service cannot read them). */
  evidencePending(scope: MaxLinkScope): string[] {
    if (!this.service.dbLinkSummary) return [];
    const db = new Set(this.host.sources.value.filter((s) => s.info.kind === "otzaria-db").flatMap((s) => s.books.map((b) => b.key)));
    return this.selection(scope).filter((k) => db.has(k) && !this.checked.has(k));
  }

  /**
   * Reads the existing links of the selected database books (DbLinkSummary: COMMENTARY, TARGUM and
   * MIDRASH counts per other book) so the plan can pair what declarations and titles do not ("בית יוסף"
   * on "טור"). Once per book; the first EVIDENCE_BOOKS unread ones. False when cancelled.
   */
  async gatherEvidence(scope: MaxLinkScope): Promise<boolean> {
    const summary = this.service.dbLinkSummary?.bind(this.service);
    if (!summary) return true;
    const books = this.host.books.value;
    const todo = this.evidencePending(scope);
    const now = todo.slice(0, EVIDENCE_BOOKS);
    this.unchecked.value = todo.length - now.length;
    if (!now.length) return true;
    const found: LinkedEvidence[] = [];
    const db = new Set(this.host.sources.value.filter((s) => s.info.kind === "otzaria-db").flatMap((s) => s.books.map((b) => b.key)));
    const ok = await this.host.runTask(`בודק אילו ספרים כבר מקושרים במסד כפירוש ובסיס (${now.length.toLocaleString("he")} ספרים)…`, async (opts) => {
      let done = 0;
      const read = async (k: string, of: number) => {
        opts.signal?.throwIfAborted();
        const s = await summary(k, opts.signal ? { signal: opts.signal } : {});
        this.checked.add(k);
        this.checkedCount.value++;
        if ("byBook" in s) for (const e of evidenceFromCounts(k, s.byBook)) if (books.has(e.dependant) && books.has(e.base)) found.push(e);
        opts.onProgress?.(++done, of);
      };
      for (const k of now) await read(k, now.length);
      // the books they are most linked to, when only their own links tell what those are written on
      // (plan.ts evidenceToFollow: "ספרא" for "מלבי"ם על ויקרא")
      const next = evidenceToFollow(found, books)
        .filter((k) => db.has(k) && !this.checked.has(k))
        .slice(0, Math.max(0, EVIDENCE_BOOKS - now.length));
      for (const k of next) await read(k, now.length + next.length);
      return true;
    }, (d, t) => countOf("ספר", d, t));
    if (found.length) {
      const next = new Map(this.evidence.value);
      for (const e of found) next.set(e.dependant, [...(next.get(e.dependant) ?? []), e]);
      this.evidence.value = next;
    }
    return ok === true;
  }

  /**
   * The plan for a scope, with only the ticked engines (all when `engines` is absent). `preferSource`:
   * the source whose books are the bases when a base is open in several (MaxLinkPlan.baseSources).
   */
  plan(scope: MaxLinkScope, engines?: ReadonlySet<EngineId>, preferSource?: string, choices?: PlanChoices): MaxLinkPlan {
    return planMaxLink({ selected: this.selection(scope), library: this.planLibrary(), ...(engines && { engines }), ...(preferSource && { preferSource }), ...(choices && { choices }) });
  }

  /** Whether the commentary's titles fit its base (linking/title-fit.ts), for the screens that offer the headings method; null when the service cannot tell. */
  titleFit(commentaryKey: string, baseKey: string): Promise<TitleFitReport | null> {
    return this.service.titleFit ? this.service.titleFit(this.host.refOf(commentaryKey), this.host.refOf(baseKey)) : Promise.resolve(null);
  }

  /**
   * Pair mode with several targets (issue #26): ONE book against each of the chosen books, with the chosen
   * methods per pair (default: the relation's own — headings and dibur-hamatchil for a commentary — merged into one
   * run, as a max-link run is). The relation is the user's, not read from the names or the database. The plan
   * carries these choices, so run() keeps them in the job. Books that are not open are left out.
   */
  pairPlan(dependantKey: string, baseKeys: readonly string[], methods?: readonly PairEngineId[], kind?: RelationKind): MaxLinkPlan {
    const title = (k: string) => this.host.refOf(k).title;
    const bases = [...new Set(baseKeys)].filter((k) => k !== dependantKey && this.host.books.value.has(k));
    const dependant = title(dependantKey);
    const pairs = bases.map((k) => ({ dependant, base: title(k), dependantKey, baseKey: k, ...(kind && { kind }) }));
    const chosen: Record<string, readonly PairEngineId[]> = {};
    if (methods?.length) for (const k of bases) chosen[pairMethodKey(dependant, title(k))] = methods;
    return this.plan({ kind: "books", keys: [dependantKey] }, new Set(PAIR_ENGINES), undefined, { pairs, ...(Object.keys(chosen).length && { methods: chosen }) });
  }

  /* ---------------- the batch job (V5 P1-8) ---------------- */

  /**
   * The current job: the run of a plan book after book (linking/batch-job.ts), with every book's status.
   * Kept in the browser next to the autosave (startPersist), so a reload or a closed tab can continue it.
   */
  readonly job = signal<JobRecord | null>(null);
  /** the job came from an earlier session: its books must be open again, and its results are read back on resume */
  readonly jobRestored = signal(false);
  /** a job's books are running now */
  readonly running = signal(false);
  /** the steps of each book of the job, by title (this session's plan) */
  private jobSteps: Map<string, PlanStep[]> | null = null;
  private jobPlan: MaxLinkPlan | null = null;
  /** what each finished book left, by title */
  private readonly results = new Map<string, BookResult>();
  private kv: KeyValueStore | null = null;
  private ctl: AbortController | null = null;
  private stopAs: "paused" | "cancelled" | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Runs a plan as a job, book after book, and makes the merged suggestions of every finished book the
   * current run — also when the job is paused or cancelled half way. True when there is a run to show.
   */
  async run(plan: MaxLinkPlan, scopeLabel: string, options: MaxLinkRunOptions = {}): Promise<boolean> {
    if (!this.service.runMaxLink) return void this.host.notify("error", "קישור מרבי אינו זמין בגרסה הזו של הכלי."), false;
    if (this.running.peek()) return void this.host.notify("warning", "קישור מרבי כבר רץ. השהו או עצרו אותו לפני הרצה חדשה."), false;
    if (!plan.steps.length) {
      this.host.notify("warning", "אין מה להריץ: לא נמצא אף ספר שאפשר לקשר אוטומטית.", plan.books.filter((b) => b.skipped).map((b) => `${b.book.title}: ${b.skipped}`));
      return false;
    }
    const preferBase = options.preferSource ? this.host.sources.value.find((s) => s.info.id === options.preferSource)?.info.label : undefined;
    const job = jobFromPlan(plan, {
      scope: scopeLabel,
      sources: [...new Set(plan.books.map((b) => this.labelOfKey(b.book.key)).filter(Boolean))],
      engines: Object.keys(plan.perEngine) as EngineId[],
      ...(options.engineOptions && Object.keys(options.engineOptions).length && { engineOptions: options.engineOptions }),
      ...(preferBase && { preferBase }),
      // the books by title only: session keys are not kept in a job (a resumed job plans from the titles)
      ...(plan.choices && { choices: { ...plan.choices, ...(plan.choices.pairs && { pairs: plan.choices.pairs.map(({ dependantKey: _d, baseKey: _b, ...rest }) => rest) }) } }),
    });
    this.dropStored(this.job.peek());
    this.results.clear();
    this.useSteps(plan);
    batch(() => {
      this.jobRestored.value = false;
      this.job.value = job;
    });
    return this.drive();
  }

  /** Pauses the job: the book that runs now is stopped and waits, the finished ones stay. */
  pause(): void {
    if (!this.running.peek()) return;
    this.stopAs = "paused";
    this.ctl?.abort();
  }

  /** Stops the job: the finished books stay (their suggestions are shown), the rest wait for "המשך". */
  cancel(): void {
    if (!this.running.peek()) return;
    this.stopAs = "cancelled";
    this.ctl?.abort();
  }

  /** Continues a paused, cancelled or restored job with the books that wait. */
  async resume(): Promise<boolean> {
    if (this.running.peek() || !this.job.peek()) return false;
    if (!(await this.ensurePlan())) return false;
    return this.drive();
  }

  /** Runs again only the books that failed. */
  async retryFailed(): Promise<boolean> {
    if (this.running.peek() || !this.job.peek()) return false;
    if (!(await this.ensurePlan())) return false;
    this.setBooks((b) => (b.status === "failed" ? (this.results.delete(b.title), { ...withoutWhy(b), status: "pending" }) : b));
    return this.drive();
  }

  /**
   * Runs the job again where it matters: books whose text, bases or steps changed since their last run
   * (fingerprints), and the ones that failed or wait. An unchanged book keeps its result and is skipped.
   * The user's decisions are links and rejections of the project: a re-run never touches them, and a
   * changed book says how many of them it holds, to be checked.
   */
  async rerunChanged(): Promise<boolean> {
    if (this.running.peek() || !this.job.peek()) return false;
    if (!(await this.ensurePlan(true))) return false;
    this.setBooks((b) => (b.status === "failed" ? (this.results.delete(b.title), { ...withoutWhy(b), status: "pending" }) : b));
    return this.drive();
  }

  /** Forgets the job (its stored results too). The suggestions shown stay until the next run. */
  discardJob(): void {
    if (this.running.peek()) return;
    this.dropStored(this.job.peek());
    this.results.clear();
    this.jobSteps = null;
    this.jobPlan = null;
    batch(() => {
      this.job.value = null;
      this.jobRestored.value = false;
    });
    void this.kv?.delete(JOB_KEY).catch(() => {});
  }

  /** The per-book report of the job as CSV. */
  saveJobReport(): void {
    const job = this.job.peek();
    if (job) this.saver.save(`קישור-מרבי-ספרים-${new Date().toISOString().slice(0, 10)}.csv`, jobCsv(job), "text/csv;charset=utf-8");
  }

  /** The titles of the job's books (the bases among them) that are not open now: they cannot run until they are. */
  missingTitles(): string[] {
    const job = this.job.value;
    if (!job) return [];
    const open = new Set([...this.host.books.value.values()].map((b) => b.title));
    return job.books.filter((b) => !open.has(b.title)).map((b) => b.title);
  }

  /** Keeps the job in the browser (IndexedDB, next to the autosave), and offers a job an earlier session left. */
  startPersist(kv: KeyValueStore): () => void {
    this.kv = kv;
    void kv.get(JOB_KEY).then(
      (text) => {
        const r = parseJobRecord(text);
        if (r && !this.job.peek())
          batch(() => {
            this.job.value = r;
            this.jobRestored.value = true;
          });
      },
      () => {},
    );
    return () => clearTimeout(this.saveTimer);
  }

  private useSteps(plan: MaxLinkPlan): void {
    this.jobPlan = plan;
    this.jobSteps = new Map([...stepsByBook(plan)].map(([key, steps]) => [this.host.refOf(key).title, steps] as const));
  }

  private setBooks(f: (b: JobBook) => JobBook): void {
    const job = this.job.peek();
    if (job) this.job.value = { ...job, books: job.books.map(f) };
  }

  private setBook(title: string, next: JobBook): void {
    this.setBooks((b) => (b.title === title ? next : b));
  }

  private labelOfKey(key: string): string {
    return this.host.sources.value.find((s) => s.info.id === sourceIdOfBookKey(key))?.info.label ?? "";
  }

  /**
   * The job's plan in this session: kept while its books are open; else planned again (the same books, by
   * title, the same engines and bases) — after a reload, with its stored results read back, or after its
   * folder was opened again — and then the finished books whose text changed meanwhile run again
   * (markChanged; `skip` marks the others "unchanged"). False when none of its books is open, or cancelled.
   */
  private async ensurePlan(skip = false): Promise<boolean> {
    const job = this.job.peek()!;
    // the plan of this session stands while all its books are open (closing and reopening a folder gives them new keys)
    const open = this.host.books.value;
    if (this.jobSteps && !this.jobRestored.peek() && [...this.jobSteps.values()].every((steps) => steps.every((st) => open.has(st.source.key) && (st.kind !== "pair" || open.has(st.target.key)))))
      return !skip || (await this.markChanged(true)) !== null;
    const labels = new Set(job.sources);
    // a title open in several sources: the one from the job's own sources
    const byTitle = new Map<string, string>();
    for (const s of this.host.sources.value) for (const b of s.books) if (!byTitle.has(b.title) || (labels.has(s.info.label) && !labels.has(this.labelOfKey(byTitle.get(b.title)!)))) byTitle.set(b.title, b.key);
    const keys = job.books.flatMap((b) => byTitle.get(b.title) ?? []);
    if (!keys.length) {
      this.host.notify("warning", `כדי להמשיך, פתחו שוב את ${job.sources.length > 1 ? "המקורות" : "המקור"} ${job.sources.map((l) => `"${l}"`).join(", ")}.`);
      return false;
    }
    const prefer = job.preferBase ? this.host.sources.value.find((s) => s.info.label === job.preferBase)?.info.id : undefined;
    const plan = planMaxLink({ selected: keys, library: this.planLibrary(), ...(job.engines && { engines: new Set(job.engines) }), ...(prefer && { preferSource: prefer }), ...(job.choices && { choices: job.choices }) });
    this.useSteps(plan);
    // the results kept, bound to this session's books by title
    const keyOf = (t: string) => byTitle.get(t);
    for (const r of this.results.values()) rebind(r, keyOf);
    if (this.jobRestored.peek()) {
      for (const [i, b] of job.books.entries()) {
        if (b.status === "pending" || b.status === "not-planned") continue;
        const r = parseBookResult(await this.kv?.get(resultKey(job.id, i)).catch(() => null));
        if (!r) {
          // nothing kept for it (storage was full or cleared): it runs again
          if (b.status !== "failed") this.setBook(b.title, { ...withoutWhy(b), status: "pending" });
          continue;
        }
        rebind(r, keyOf);
        this.results.set(b.title, r);
      }
      this.jobRestored.value = false;
    }
    // a book edited while the tab was closed, or before its folder was opened again, must not keep its old suggestions
    return (await this.markChanged(skip)) !== null;
  }

  /**
   * Compares the fingerprints of the finished books with this session's texts: a changed one waits to run
   * again (its old result goes); `skip` marks the unchanged ones "unchanged" (a re-run that skips them).
   * Returns the number of changed books, or null when cancelled.
   */
  private async markChanged(skip: boolean): Promise<number | null> {
    const job = this.job.peek()!;
    const steps = this.jobSteps!;
    const fingerprints = this.service.fingerprints?.bind(this.service);
    const finished = new Set(job.books.filter((b) => (b.status === "done" || b.status === "no-match" || b.status === "unchanged") && steps.has(b.title)).map((b) => b.title));
    if (!finished.size) return 0;
    const keys = [...new Set([...finished].flatMap((t) => fingerprintKeys(steps.get(t)!)))];
    const fps = fingerprints ? await this.host.runTask(`בודק אילו ספרים השתנו (${finished.size.toLocaleString("he")})…`, (opts) => fingerprints(keys, opts), (d, t) => countOf("ספר", d, t)) : {};
    if (fps === null) return null;
    let changed = 0;
    const decisions = this.decisionsByTitle();
    this.setBooks((b) => {
      if (!finished.has(b.title)) return b;
      const fp = bookFingerprint(steps.get(b.title)!, fps, job.engineOptions);
      if (fp && fp === b.fingerprint) return skip ? { ...b, status: "unchanged" } : b;
      changed++;
      this.results.delete(b.title);
      const kept = decisions.get(b.title) ?? 0;
      return { ...withoutWhy(b), status: "pending", ...(kept && { changedDecisions: kept }) };
    });
    if (changed)
      this.host.notify("info", `${changed === 1 ? "ספר אחד השתנה" : `${changed.toLocaleString("he")} ספרים השתנו`} מאז שקושרו, ו${changed === 1 ? "ירוץ" : "ירוצו"} שוב. הקישורים שכבר אישרתם וההצעות שדחיתם נשמרים כמו שהם.`);
    return changed;
  }

  /** The user's decisions on each book: the project's links on it (approved, edited, made by hand) and the rejections that name it. */
  private decisionsByTitle(): Map<string, number> {
    const out = new Map<string, number>();
    const add = (t: string) => out.set(t, (out.get(t) ?? 0) + 1);
    for (const l of this.host.linkState.value.links.values()) {
      if (l.provenance === "db" || l.status === "deleted") continue;
      add(l.source.book.title);
      if (l.target.book.title !== l.source.book.title) add(l.target.book.title);
    }
    // rejectionKey: "<engine>|<title>#<line>…><title>#<line>…"
    for (const k of this.host.linkState.value.rejected) for (const t of new Set(k.match(/[^|>@<*]+(?=#\d)/g) ?? [])) add(t);
    return out;
  }

  /** The open books as the planner reads them (with the database's evidence gathered so far). */
  private planLibrary(): PlanBook[] {
    const evidence = this.evidence.value;
    return [...this.host.books.value.values()].map((b) => {
      // default_commentator (read at open) is commentary evidence like a COMMENTARY link
      const own = (b.linkedBases ?? []).map((base): LinkedEvidence => ({ dependant: b.key, base }));
      const fields = linkedFields([...own, ...(evidence.get(b.key) ?? [])]).get(b.key);
      return {
        ...this.host.refOf(b.key),
        ...(b.bases && { bases: b.bases }),
        ...(b.dependence && { dependence: b.dependence }),
        ...(b.lineCount !== undefined && { lineCount: b.lineCount }),
        ...linkedProps(fields),
      };
    });
  }

  /** Runs the books that wait, one worker call each; then shows the merged run of every finished book. */
  private async drive(): Promise<boolean> {
    if (!this.service.runMaxLink) return false;
    const run = this.service.runMaxLink.bind(this.service);
    const job = this.job.peek()!;
    const steps = this.jobSteps!;
    const todo = runOrder(job.books.filter((b) => b.status === "pending" && steps.has(b.title)).map((b) => b.title), steps);
    const totals = jobTotals(job);
    const of = totals.runnable;
    let settled = totals.settled;
    this.stopAs = null;
    batch(() => {
      this.running.value = true;
      this.job.value = { ...job, state: "running" };
    });
    const t0 = Date.now();
    const engineOptions = job.engineOptions;
    const sefariaOwned = this.host.sefariaOwnedKeys?.();
    let lost = false;
    await this.host.runTask(
      `קישור מרבי: ${of.toLocaleString("he")} ספרים…`,
      async (opts) => {
        const ctl = (this.ctl = new AbortController());
        // the app bar's cancel stops the job like "עצירה": the finished books stay
        opts.signal?.addEventListener("abort", () => ((this.stopAs ??= "cancelled"), ctl.abort()), { once: true });
        for (const title of todo) {
          if (ctl.signal.aborted) break;
          const own = steps.get(title)!;
          const t = Date.now();
          const at = settled * UNIT;
          try {
            // a pause or stop hands back what the book's engines found so far (keepPartial): shown as partial
            const res = await run(own, { ...(engineOptions && { engineOptions }), ...(sefariaOwned && { sefariaOwned }) }, { signal: ctl.signal, keepPartial: true, onProgress: (d, n) => opts.onProgress?.(at + (n > 0 ? Math.min(UNIT - 1, Math.floor((d / n) * UNIT)) : 0), of * UNIT) });
            if (res.stopped) {
              this.takePartial(title, own, res);
              break;
            }
            this.take(title, own, res, Date.now() - t);
          } catch (err) {
            if (ctl.signal.aborted) break;
            const e = err as { code?: string; message?: string };
            const book = this.job.peek()!.books.find((b) => b.title === title)!;
            if (e.code === "worker/restarted") {
              // the reading engine crashed on this book: it fails (the next run goes on without it), and the open books are gone
              this.setBook(title, failBook(book, `מנוע הקריאה קרס בזמן הקישור של הספר הזה. ${e.message ?? ""}`.trim(), Date.now() - t));
              lost = true;
              this.stopAs = "paused";
              break;
            }
            this.setBook(title, failBook(book, e.message ?? String(err), Date.now() - t));
          }
          settled++;
          opts.onProgress?.(settled * UNIT, of * UNIT);
          this.saveSoon();
        }
        this.ctl = null;
      },
      (d, t) => countOf("ספר", Math.min(Math.floor(d / UNIT) + 1, t / UNIT), t / UNIT),
    );
    const left = this.job.peek()!.books.some((b) => b.status === "pending" && steps.has(b.title));
    const state: JobState = this.stopAs ?? (left ? "paused" : "done");
    this.stopAs = null;
    batch(() => {
      this.running.value = false;
      const j = this.job.peek()!;
      this.job.value = { ...j, state, ms: j.ms + (Date.now() - t0) };
    });
    this.saveNow();
    const shown = this.publish();
    const t = jobTotals(this.job.peek()!);
    const failed = t.byStatus.failed;
    if (state !== "done")
      this.host.notify(
        "info",
        `הקישור המרבי ${state === "paused" ? "הושהה" : "נעצר"}: ${t.settled.toLocaleString("he")} מתוך ${t.runnable.toLocaleString("he")} ספרים הסתיימו${shown ? ", וההצעות שלהם כאן" : ""}.${partialText(this.job.peek()!)} "המשך" ממשיך מהספר הבא${lost ? " אחרי שתפתחו שוב את הספרים" : ""}.`,
      );
    else if (shown) {
      const c = this.report.value!.overall;
      this.host.notify(
        failed ? "warning" : "success",
        `הקישור המרבי הסתיים: ${c.links.toLocaleString("he")} הצעות — ${c.certain.toLocaleString("he")} ודאיות, ${c.review.toLocaleString("he")} לבדיקה, ${c.existing.toLocaleString("he")} כבר קיימות${t.byStatus.unchanged ? `; ${t.byStatus.unchanged.toLocaleString("he")} ספרים לא השתנו ודולגו` : ""}${failed ? `; ${failed.toLocaleString("he")} ספרים נכשלו (אפשר להריץ שוב רק אותם)` : ""}.`,
      );
    }
    return shown;
  }

  /** A book stopped while it ran: what its engines found is shown (partial); the book still waits, and runs again from its start. */
  private takePartial(title: string, steps: readonly PlanStep[], res: MaxLinkJobResult): void {
    const result = this.resultOf(title, steps, res);
    if (!result.steps.some((s) => s.item.result?.suggestions.length)) return;
    this.results.set(title, { ...result, partial: true });
    const book = this.job.peek()!.books.find((b) => b.title === title)!;
    this.setBook(title, { ...book, partial: result.steps.reduce((n, s) => n + (s.item.result?.suggestions.length ?? 0), 0) });
  }

  private resultOf(title: string, steps: readonly PlanStep[], res: MaxLinkJobResult): BookResult {
    const byId = new Map(steps.map((s) => [s.id, s]));
    const stored: StoredStep[] = res.items.flatMap((it) => {
      const s = byId.get(it.stepId);
      return s ? [{ id: s.id, kind: s.kind, engine: s.engine, ...(s.kind === "pair" && { target: s.target }), item: withStableIds(it) }] : [];
    });
    return {
      title,
      source: steps[0]!.source,
      steps: stored,
      dbLinkKeys: res.dbLinkKeys,
      ...(res.dbLinksUnread?.length && { dbLinksUnread: res.dbLinksUnread.map((u) => ({ title: this.host.refOf(u.key).title, why: u.why })) }),
    };
  }

  /** Keeps what one book's call returned (ids without session keys), and its status. */
  private take(title: string, steps: readonly PlanStep[], res: MaxLinkJobResult, ms: number): void {
    const job = this.job.peek()!;
    const result = this.resultOf(title, steps, res);
    const stored = result.steps;
    this.results.set(title, result);
    const i = job.books.findIndex((b) => b.title === title);
    const done = stored.map((s) => ({ engine: s.engine, ...(s.item.error !== undefined && { error: s.item.error }), suggestions: s.item.result?.suggestions.length ?? 0 }));
    this.setBook(title, finishBook(job.books[i]!, done, ms, bookFingerprint(steps, res.fingerprints ?? {}, job.engineOptions)));
    void this.kv?.set(resultKey(job.id, i), JSON.stringify(result)).catch(() => {
      /* storage full: the book runs again after a reload (ensurePlan) */
    });
  }

  private saveSoon(): void {
    if (!this.kv || this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => this.saveNow(), 1000);
  }

  private saveNow(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    const job = this.job.peek();
    if (job && this.kv) void this.kv.set(JOB_KEY, JSON.stringify(job)).catch(() => {});
  }

  private dropStored(job: JobRecord | null): void {
    if (!job || !this.kv) return;
    for (let i = 0; i < job.books.length; i++) void this.kv.delete(resultKey(job.id, i)).catch(() => {});
  }

  /** Makes the merged suggestions of every finished book the current run. False when no book finished. */
  private publish(): boolean {
    const job = this.job.peek()!;
    const plan = this.jobPlan!;
    const items: MergeItem[] = [];
    const outcomes: StepOutcome[] = [];
    const db = new Set<string>();
    // books whose database links the worker could not read: said, and a bulk approval waits for retryDbLinks (review C13)
    const unread: { key: string; title: string; why: string }[] = [];
    for (const b of job.books) {
      const r = this.results.get(b.title);
      if (!r) continue;
      for (const k of r.dbLinkKeys) db.add(k);
      for (const u of r.dbLinksUnread ?? []) unread.push({ key: r.source.key, title: u.title, why: u.why });
      for (const s of r.steps) {
        for (const sg of s.item.result?.suggestions ?? []) items.push({ suggestion: sg, focus: r.source.key });
        outcomes.push({
          id: s.id,
          kind: s.kind,
          engine: s.engine,
          source: r.source,
          ...(s.target && { target: s.target }),
          raw: s.item.result?.suggestions.length ?? 0,
          unmatched: s.item.unmatched,
          ms: s.item.ms,
          ...(s.item.error !== undefined && { error: s.item.error }),
          notes: s.item.result?.notes ?? [],
        });
      }
    }
    if (!outcomes.length) return false;
    const scopeLabel = job.scope;
    // "already exists": the database's links, and the project's — except the link a suggestion's own approval made
    const project = new Map<string, string[]>();
    for (const l of this.host.linkState.value.links.values()) if (l.status !== "deleted") pushTo(project, linePairKey(l), l.id);
    // the books a book is aimed at in more than one way (the user's own pairs, PlanChoices.pairs, and any commentary the plan relates to two
    // whole books): a line is never linked to several of them blindly (merge.ts step 4d)
    const userTargets = [...new Set([...plan.steps.flatMap((s) => (s.kind === "pair" && s.relation.via === "user" ? [s.target.key] : [])), ...competingTargets(plan.steps)])];
    const raw = mergeSuggestions(items, {
      reference: db,
      ...(userTargets.length > 1 && { candidateBooks: userTargets }),
      existing: (s) => (db.has(linePairKey(s)) ? "db" : project.get(linePairKey(s))?.some((id) => id !== `auto:${stableId(s)}`) ? "project" : null),
    });
    // the merged ids are made of book keys too: without them an approval is recognised in every session (stableId)
    // a pair's own threshold (UserPair.minConfidence): the suggestions below it are not shown, and the count is said
    const limited = applyPairMinimums(raw.suggestions, plan.minConfidence ?? {});
    const merged = { ...raw, suggestions: limited.kept.map((s) => ({ ...s, id: stableId(s) })) };

    const info: MaxLinkRunInfo = { scope: scopeLabel, books: plan.books, identified: plan.identified, steps: outcomes, stats: merged.stats, ms: job.ms };
    const failed = outcomes.filter((o) => o.error).length;
    const st = merged.stats;
    const notes: Reason[] = [
      {
        code: "maxlink/summary",
        text: `${st.input.toLocaleString("he")} הצעות מ־${outcomes.length.toLocaleString("he")} שלבים אוחדו ל־${st.output.toLocaleString("he")}: ${(st.duplicates - st.outweighed).toLocaleString("he")} כפילויות אוחדו, ${st.agreements.toLocaleString("he")} קישורים ששתי שיטות או יותר הגיעו אליהם, ${st.settled.toLocaleString("he")} סתירות בין שיטות הוכרעו לפי הראיות (${st.outweighed.toLocaleString("he")} הצעות שנדחו מוצגות כמועמדים חלופיים), ${st.conflicts.toLocaleString("he")} לא הוכרעו (מסומנות "עמומה").`,
      },
      ...(st.contradictedPairs
        ? [{ code: "maxlink/contradicts-library", text: `ב־${st.contradictedPairs} זוגות ספרים ההצעות סותרות את הקישורים שכבר יש בספרייה ברוב השורות (למשל ספר שממוספר בדפים משלו). שם אף הצעה אינה "ודאית"; הן מסומנות לבדיקה.` }]
        : []),
      ...(st.suspectPairs
        ? [{ code: "maxlink/pair-disagree", text: `ב־${st.suspectPairs} זוגות ספרים השיטות סותרות זו את זו ברוב השורות (למשל ספר שממוספר בדפים משלו). שם אף הצעה של שיטה אחת אינה "ודאית"; הן מסומנות לבדיקה.` }]
        : []),
      ...(limited.hidden ? [{ code: "maxlink/below-pair-minimum", text: `${limited.hidden.toLocaleString("he")} הצעות לא מוצגות: הן מתחת לסף הביטחון שבחרתם לזוג הספרים שלהן.` }] : []),
      ...(failed ? [{ code: "maxlink/errors", text: `${failed} שלבים נכשלו; שאר השלבים רצו. הפרטים ב"דוח הקישור המרבי".` }] : []),
      ...(partialText(job) ? [{ code: "maxlink/partial", text: partialText(job).trim() }] : []),
    ];
    batch(() => {
      this.host.suggestions.dbLinkKeys.value = db;
      this.host.suggestions.run.value = { engine: outcomes[0]!.engine, label: `${scopeLabel}: ${plan.books.length.toLocaleString("he")} ספרים`, result: { suggestions: merged.suggestions, notes, unmatched: [] }, at: Date.now(), maxlink: info, ...(unread.length && { dbLinksUnread: unread.map(({ key, title }) => ({ key, title })) }) };
      this.host.suggestions.current.value = merged.suggestions[0]?.id ?? null;
      this.host.sideTab.value = "suggestions";
    });
    if (unread.length)
      this.host.notify(
        "warning",
        `הקישורים שכבר יש במסד ל־${unread.map((u) => `"${u.title}"`).join(", ")} לא נקראו, ולכן הצעות שכבר קיימות בספרייה עלולות להופיע כממתינות. אישור של כמה הצעות יחד מושבת עד שהם ייקראו: לחצו "קריאה חוזרת" בחלונית ההצעות.`,
        unread.map((u) => `${u.title}: ${u.why}`),
      );
    return true;
  }

  saveReport(): void {
    const rep = this.report.value;
    if (rep) this.saver.save(`קישור-מרבי-${new Date().toISOString().slice(0, 10)}.csv`, reportCsv(rep), "text/csv;charset=utf-8");
  }
}
