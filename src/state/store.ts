import { embeddedLibraryLinkFiles } from "../core/links/library-link-files";
import { pushTo } from "../core/collections";
import { batch, computed, effect, signal, type ReadonlySignal } from "@preact/signals";
import { parseProject, serializeProject, type ProjectSource } from "../projects/project-format";
import { sourceIdOfBookKey, type SourceBook } from "../core/books";
import { describeMapping, mappingProblems, type DbMapping, type MappingTest, type PendingDb, type SavedDbMapping } from "../core/db-mapping";
import { AUTHORABLE_TYPES, parseConnectionType } from "../core/links/connection-type";
import { matchedAfterEdit } from "../core/links/matched";
import type { BookOrigin, BookRef, Link, LinkSide, RawAnchor } from "../core/links/model";
import { path2ForTitle, safeFileTitle, titleDeclaresDependencyOn, titleFromPath2 } from "../core/links/titles";
import { validateLink, type LineFacts, type Problem, type ValidationContext } from "../core/links/validate";
import { dropStalePipelineFields } from "../core/links/pipeline-fields";
import { sefariaRefFromHeRef } from "../core/links/sefaria-ref";
import { embeddedSefariaTitles, hasSefariaTitle, isSefariaOwned, parseSefariaTitles, type SefariaTitles } from "../core/links/sefaria-titles";
import { stripTags } from "../core/text/html";
import type { EngineId } from "../linking/automatic";
import { pairByTitle, pairOne, titleIndex } from "../linking/batch";
import { addChanges, altTocChange, booksCount, booksOpened, commit, deleteChange, editChange, emptyLinkState, fileChange, filesCount, linksCount, rebindLinks, redo, restoreChange, touch, travel, undo, type AltTocChange, type Change, type LinkState } from "./history";
import { AltTocState } from "./alt-toc";
import { CHUNK, LineStore } from "./lines";
import { BookFind } from "./book-find";
import { planRelink, type RelinkItem, type RelinkPlan } from "../linking/relink";
import { editionRows, lineMappingCsv, type EditionDiff, type EditionRow } from "../linking/edition-map";
import { loadPreferences, type Preferences } from "./preferences";
import type { DialogId, SuggestMode } from "./router";
import { diagnosticsFile, diagnosticsFileName, diagnosticsLog, logNotice, logTask } from "./diagnostics";
import { DbLinksState } from "./db-links";
import { LinkCompareState } from "./link-compare";
import { LinkFixes } from "./link-fixes";
import { CoverageState } from "./coverage";
import { RangesState } from "./ranges";
import type { BooksService, InputFile, KeyValueStore, OpenedSource, Saver } from "./services";
import { MaxLinkState } from "./maxlink";
import { SuggestionsState } from "./suggestions";
import { roleLabels } from "./roles";
import { ExchangeState } from "./exchange";
import { PersonalCsvState } from "./personal-csv";
import { RepositoryState } from "./repository";
import { QualityState } from "./quality";
import { GuidedFlowState, type GuidedStep } from "./guided-flow";

/*
 * The application state (stage 14, architecture rule 9): signals for what the screens show, and
 * methods for everything a user can do. Screens read signals and call methods; they never change
 * links directly. Links change only through history.commit, so every action is undoable.
 *
 * The store itself keeps the open sources, reading and picking, the builder, the project's links and
 * their history, projects and autosave, notices and tasks, and the rules context (validation()) that
 * the builder, the export and the quality check share. Everything else is a module the store creates
 * and exposes as a readonly field, each with a narrow Host interface the store satisfies: suggestions,
 * exchange (import and export), quality, maxLink, dbLinks, altToc, ranges.
 */

export type Side = "source" | "target";

/** What the user picked in a reader: a line, a range (shift-click), and optionally words (an anchor). */
export interface Pick {
  bookKey: string;
  line: number;
  end?: number;
  /** word anchor on this line, in RAW offsets of the line's anchor text, with the words for display */
  anchor?: RawAnchor & { text: string };
}

export type NoticeKind = "info" | "success" | "warning" | "error";
export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
  /** longer explanation (list of skipped files, problems…) */
  details?: string[];
  action?: { label: string; run: () => void };
  /** stays until closed (notice-policy.ts) */
  sticky?: boolean;
}

export interface Task {
  label: string;
  done: number;
  total: number;
  cancel: () => void;
  /** Date.now() when it started: the app bar estimates the time left from it (audit F21) */
  startedAt: number;
  /** the progress in the task's own units ("ספר 120 מתוך 300"), when it has any */
  count?: string;
}

export type Screen = "home" | "workspace" | "guided";
export type SideTab = "builder" | "links" | "suggestions" | "qa" | "books";

/**
 * Whether a book saved with one origin may be the open book of another (#41 B18): a personal book is
 * only ever a personal one, a library book (otzaria/sefaria) never a personal one; "unknown" (an import by
 * title, an old project) may be either.
 */
const sameOrigin = (saved: BookOrigin, open: BookOrigin): boolean => saved === "unknown" || open === "unknown" || (saved === "personal") === (open === "personal");

export class AppStore {
  readonly prefs: Preferences;
  readonly lines: LineStore;
  /** the search box of each reader */
  readonly find: Record<Side, BookFind>;
  /** alternative TOC structures (alt_toc) of the project */
  readonly altToc: AltTocState;
  /** links the open databases already have: list, per-line view, copying into the project (stage 10) */
  readonly dbLinks: DbLinksState;
  /** comparing and merging a book's links between the database, the project and links files */
  readonly compare: LinkCompareState;
  /** group fixes of the links table */
  readonly fixes: LinkFixes;
  /** max-link: plan, run and report (state/maxlink.ts) */
  readonly maxLink: MaxLinkState;
  /** range suggestions, cutting and completion (state/ranges.ts) */
  readonly ranges: RangesState;
  /** which lines of a book are linked, partly covered or still unlinked (state/coverage.ts) */
  readonly coverage: CoverageState;
  /** automatic suggestions: engine, citations and batch runs, and the user's decisions (state/suggestions.ts) */
  readonly suggestions: SuggestionsState;
  /** importing links files, sheets and records; the export (state/exchange.ts) */
  readonly exchange: ExchangeState;
  /** the quality check and its report (state/quality.ts) */
  readonly quality: QualityState;
  /** export of a personal book's links to the official library as the personal-database build's links.csv (state/personal-csv.ts) */
  readonly personalCsv: PersonalCsvState;
  /** the analysis of an open database as a whole (the repository path of the home screen) */
  readonly repository: RepositoryState;
  /** the guided flow "link a folder to Otzaria" (state/guided-flow.ts, route "#/guided/<step>") */
  readonly guided: GuidedFlowState;

  readonly screen = signal<Screen>("home");
  readonly sources = signal<OpenedSource[]>([]);
  readonly linkState = signal<LinkState>(emptyLinkState());
  readonly view = { source: signal<string | null>(null), target: signal<string | null>(null) };
  readonly pick = { source: signal<Pick | null>(null), target: signal<Pick | null>(null) };
  /** the link whose two ends revealLink last showed: its matched words (issue #11) are painted while those lines stay picked */
  readonly revealedLink = signal<Link | null>(null);
  /** the reader that receives the next click in "click" create mode and keyboard focus */
  readonly activeSide = signal<Side>("source");
  readonly draftType = signal<string>("commentary");
  /** the user chose the type; until then it follows the books (see autoType) */
  readonly draftTypeTouched = signal(false);
  /** null = automatic (from the target line); a string = typed by the user */
  readonly draftHeRef = signal<string | null>(null);
  /** Sefaria English refs — required by the library's weekly sync when that side is a Sefaria book */
  readonly draftRef1 = signal("");
  readonly draftRef2 = signal("");
  /** id of the link being edited in the builder, or null when creating */
  readonly editing = signal<string | null>(null);
  readonly notices = signal<Notice[]>([]);
  /** a request to open the coverage section of the "בדיקה" tab and bring it into view (#41 B26): bumped by "כיסוי הספר" */
  readonly coverageFocus = signal(0);
  /** a request for a reader to scroll to a line and flash it; seq makes repeated requests distinct */
  readonly focus = { source: signal<{ line: number; seq: number } | null>(null), target: signal<{ line: number; seq: number } | null>(null) };
  readonly sideTab = signal<SideTab>("builder");
  /** what the suggestions tab sets up: two books, a batch, or max-link (the route "#/maxlink") */
  readonly suggestMode = signal<SuggestMode>("pair");
  /** the guided task whose sheet is open on the home screen (dialog "start") */
  readonly startTask = signal<string | null>(null);
  /** unsaved work found from a previous session, until the user restores or dismisses it */
  readonly recovery = signal<{ links: number; restore: () => void; dismiss: () => void } | null>(null);
  /** what a home-screen task asked for: the engine and panel to start with (guided tasks) */
  readonly intent = signal<{ engine?: EngineId; sourceId?: string; allBooks?: boolean } | null>(null);
  /**
   * What the two sides are called now (issue 19): by the job the user is on — only while the suggestions tab is open
   * (a finished run must not rename the sides for manual linking of other books): the run being reviewed (a max-link
   * run mixes engines: neutral), else the engine picked in the form, else the one a home task asked for. Words only:
   * the side ids never change.
   */
  readonly roles = computed(() => {
    if (this.sideTab.value !== "suggestions") return roleLabels(undefined);
    const run = this.suggestions.run.value;
    if (run?.maxlink) return roleLabels(undefined);
    return roleLabels(run?.engine ?? this.suggestions.formEngine.value ?? this.intent.value?.engine);
  });
  readonly task = signal<Task | null>(null);
  /** the link revision last written to disk — "unsaved changes" compares against it */
  readonly savedRevision = signal(0);
  /**
   * The titles the library's sync and PR gate count as Sefaria books (B6): embedded at build time,
   * replaced by the library's own file when the user opens a library folder that has it.
   */
  readonly sefariaTitles = signal<SefariaTitles>(embeddedSefariaTitles());
  /** what the export is for (B1): the library (its sync's rules are errors) or private use (warnings) */
  readonly exportPurpose = signal<"submission" | "private">("submission");

  readonly books = computed(() => {
    const m = new Map<string, SourceBook>();
    for (const s of this.sources.value) for (const b of s.books) m.set(b.key, b);
    return m;
  });
  readonly booksByTitle = computed(() => {
    const m = new Map<string, SourceBook[]>();
    for (const b of this.books.value.values()) pushTo(m, b.title, b);
    return m;
  });
  readonly allLinks = computed(() => [...this.linkState.value.links.values()]);
  readonly dirty = computed(() => this.linkState.value.revision !== this.savedRevision.value);

  /** The link the builder would create right now, or null while something is missing. */
  readonly draft = computed<Link | null>(() => {
    const s = this.pick.source.value;
    const t = this.pick.target.value;
    if (!s || !t) return null;
    this.lines.tick.value; // heRef depends on loaded lines
    const source: LinkSide = { book: this.refOf(s.bookKey), line: s.line, ...(s.end !== undefined && s.end > s.line && { end: s.end }) };
    const target: LinkSide = { book: this.refOf(t.bookKey), line: t.line, ...(t.end !== undefined && t.end > t.line && { end: t.end }) };
    const base = this.editing.value ? this.linkState.value.links.get(this.editing.value) : undefined;
    // fields the builder owns are rebuilt from scratch; everything else of an edited link is kept
    const { anchor: _a, ref1: _r1, ref2: _r2, matched: _m, ...kept } = base ?? ({ id: "draft", status: "new", provenance: "user" } as Link);
    // the Sefaria refs the library's sync needs: typed by the user, else built from the line's heRef (B1)
    const ref1 = this.draftRef1.value.trim() || (this.isSefariaOwned(source.book) ? (sefariaRefFromHeRef(this.lines.peek(s.bookKey, s.line)?.heRef) ?? "") : "");
    const ref2 = this.draftRef2.value.trim() || (this.isSefariaOwned(target.book) ? (sefariaRefFromHeRef(this.lines.peek(t.bookKey, t.line)?.heRef) ?? "") : "");
    const anchor: RawAnchor | undefined = s.anchor && { rawStart: s.anchor.rawStart, ...(s.anchor.rawEnd !== undefined && { rawEnd: s.anchor.rawEnd }), ...(s.anchor.label && { label: s.anchor.label }) };
    // the engine's matched words stay with the side the user did not change (issue #11)
    const matched = base && matchedAfterEdit(base, source, target, anchor);
    const d: Link = {
      ...kept,
      source,
      target,
      declaredType: this.draftType.value,
      // a cleared field falls back to the automatic reference: a blank heRef_2 is never written (B3)
      heRef2: this.draftHeRef.value?.trim() ? this.draftHeRef.value : this.autoHeRef(t),
      ...(anchor && { anchor }),
      ...(matched && { matched }),
      ...(ref1 && { ref1 }),
      ...(ref2 && { ref2 }),
      ...(base && base.target.book.title !== target.book.title && { targetPath: path2ForTitle(target.book.title) }),
    };
    // an edited record never keeps the sync's fields for an anchor or line it no longer has (B2)
    return base ? dropStalePipelineFields(base, d).link : d;
  });
  readonly draftProblems = computed<Problem[]>(() => {
    const d = this.draft.value;
    // editing a copied database link is fine; only its EXPORT waits for the book's links file
    // the library's rules are checked at export (purpose); here they warn, so a link is never blocked from being made
    const { linksFile: _f, ...ctx } = this.validation();
    if (!d) return [];
    const out = validateLink(d, { ...ctx, purpose: "private" });
    const base = this.editing.value ? this.linkState.value.links.get(this.editing.value) : undefined;
    if (base) {
      const dropped = dropStalePipelineFields(base, { ...d, ...(base.ref1 !== undefined && { ref1: base.ref1 }), ...(base.ref2 !== undefined && { ref2: base.ref2 }), ...(base.passthrough && { passthrough: base.passthrough }) }).dropped;
      if (dropped.includes("ref_1") && d.ref1 === undefined) out.push({ code: "edit/ref1-dropped", severity: "warning", message: `השורה בספר המקשר השתנתה, ולכן ציון ספריא הישן שלה ("${base.ref1}") הוסר: הסנכרון של הספרייה היה מחזיר את הקישור לשורה הישנה. כתבו את ציון ספריא של השורה החדשה.`, detail: "ref_1" });
      if (dropped.includes("ref_2") && d.ref2 === undefined) out.push({ code: "edit/ref2-dropped", severity: "warning", message: `השורה בספר המקושר השתנתה, ולכן ציון ספריא הישן שלה ("${base.ref2}") הוסר: הסנכרון של הספרייה היה מחזיר את הקישור לשורה הישנה. כתבו את ציון ספריא של השורה החדשה.`, detail: "ref_2" });
      const fields = dropped.filter((x) => x.startsWith("anchor_"));
      if (fields.length) out.push({ code: "edit/pipeline-fields-dropped", severity: "info", message: "פרטים שהסנכרון השבועי של הספרייה רשם על העוגן יוסרו מהקישור, כי העוגן או השורה השתנו.", detail: fields.join(", ") });
    }
    return out;
  });

  private noticeSeq = 0;
  private linkSeq = 0;

  constructor(
    private readonly service: BooksService,
    private readonly saver: Saver,
    prefs?: Preferences,
  ) {
    this.prefs = prefs ?? loadPreferences();
    this.lines = new LineStore(service);
    this.find = { source: new BookFind(service, (k, l) => this.reveal("source", k, l)), target: new BookFind(service, (k, l) => this.reveal("target", k, l)) };
    this.altToc = new AltTocState(this, service);
    this.dbLinks = new DbLinksState(this, service);
    this.compare = new LinkCompareState(this, service, saver);
    this.fixes = new LinkFixes(this);
    this.maxLink = new MaxLinkState(this, service, saver);
    this.ranges = new RangesState(this, service);
    this.coverage = new CoverageState(this, service);
    this.suggestions = new SuggestionsState(this, service);
    this.exchange = new ExchangeState(this, service, saver);
    this.quality = new QualityState(this, saver);
    this.personalCsv = new PersonalCsvState(this, service, saver);
    this.repository = new RepositoryState(this, service);
    this.guided = new GuidedFlowState(this);
  }

  /** the guided flow's step, for the router */
  get guidedStep(): ReadonlySignal<GuidedStep> {
    return this.guided.step;
  }

  /** The address asked for the guided flow (at a step): the router calls it. */
  showGuided(step?: string): void {
    this.guided.show(step);
  }

  /** Opening sources moves to the workspace — except inside the guided flow, which stays on its step. */
  private toWorkspace(): void {
    if (this.screen.peek() !== "guided") this.screen.value = "workspace";
  }

  /* ---------------- sources ---------------- */

  /**
   * What the last openFiles did to the sources: the ids it added, and the ids of open sources whose file
   * was picked again (not opened a second time, #22). A task sheet reads it to mark its step done.
   */
  lastOpen: { added: string[]; reused: string[] } = { added: [], reused: [] };

  async openFiles(files: InputFile[]): Promise<void> {
    this.lastOpen = { added: [], reused: [] };
    if (!files.length) return;
    const res = await this.runTask(`פותח ${files.length === 1 ? files[0]!.path : `${files.length} קבצים`}…`, (opts) => this.service.open(files, opts));
    if (!res) return;
    this.log.info("open", `${files.length} files`, {
      sources: res.sources.map((s) => ({ kind: s.info.kind, books: s.books.length, warnings: s.info.warnings.map((w) => w.code) })),
      documents: res.documents.map((d) => d.kind),
      skipped: res.skipped.length,
      needsMapping: res.needsMapping?.length ?? 0,
    });
    // a file that is open already is not a new source: the same sources, the same books (#22)
    const openIds = new Set(this.sources.peek().map((x) => x.info.id));
    const reused = (res.reused ?? []).filter((r) => openIds.has(r.info.id));
    // the worker holds it, the store does not (an earlier open of it was cancelled after the worker had added it): it is new here
    const orphans = (res.reused ?? []).filter((r) => !openIds.has(r.info.id));
    const fresh = [...res.sources, ...orphans];
    this.lastOpen = { added: fresh.map((x) => x.info.id), reused: reused.map((r) => r.info.id) };
    if (reused.length) {
      const names = reused.map((r) => (r.as ? `"${r.as}" (זהה בתוכנו ל"${r.info.label}")` : `"${r.info.label}"`)).join(", ");
      this.notify("info", reused.length === 1 ? `${names} כבר פתוח, ולכן לא נטען שוב. ממשיכים עם הספרים הפתוחים.` : `${names} כבר פתוחים, ולכן לא נטענו שוב. ממשיכים עם הספרים הפתוחים.`);
    }
    batch(() => {
      this.sources.value = [...this.sources.value, ...fresh];
      for (const s of fresh) for (const w of s.info.warnings) this.notify("warning", `${s.info.label}: ${w.message}`);
    });
    if (fresh.length) this.attachLinks();
    // one document that fails (a hostile file deep enough to overflow a reader…) must not lose the
    // rest of the drop: each is imported on its own, a failure is a notice (security review A7)
    const each = (kind: string, run: (path: string, text: string) => void) => {
      for (const d of res.documents)
        if (d.kind === kind)
          try {
            run(d.path, d.text);
          } catch (err) {
            this.log.error("open", "document failed", { kind, error: String((err as Error)?.name ?? err) });
            this.notify("error", `"${d.path}" לא נטען: ${(err as Error)?.message ?? String(err)}. שאר הקבצים נטענו.`);
          }
    };
    each("links-json", (p, t) => this.exchange.importLinksFile(p, t));
    each("links-csv", (p, t) => this.exchange.importLinksCsv(p, t));
    each("records", (p, t) => this.exchange.offerRecords(p, t));
    each("alt-toc-json", (p, t) => this.altToc.importFile(p, t));
    each("project", (p, t) => this.openProject(p, t));
    if (res.needsMapping?.length) await this.offerMappings(res.needsMapping); // after projects: they may hold the mapping
    for (const d of res.dictionaries ?? [])
      this.notify("info", `נטען מילון דחיסה ${d.id} (${d.path}). ספרים במסדים פתוחים שדחוסים בו ייקראו עכשיו.`);
    if (res.skipped.length) {
      // the registry calls any file with no known extension a "text file that is not .txt": for a file with no bytes that is not the reason
      const empty = new Set(files.filter((f) => f.blob.size === 0).map((f) => f.path));
      this.notify(
        "warning",
        `${filesCount(res.skipped.length)} ${res.skipped.length === 1 ? "לא נפתח" : "לא נפתחו"}.`,
        res.skipped.map((s) => `${s.path}: ${empty.has(s.path) ? "הקובץ ריק (אין בו אף בייט)." : s.reason}`),
        undefined,
        // the reason is what the user needs: it stays until closed (#41 B24 — it faded after 15 seconds)
        true,
      );
    }
    const opened = fresh.flatMap((s) => s.books);
    if (opened.length) {
      this.notify("success", `${booksOpened(opened.length)} מ־${res.sources.map((s) => `"${s.info.label}"`).join(", ")}.${this.sources.value.length > res.sources.length ? ` יחד איתם פתוחים ${this.sources.value.length.toLocaleString("he")} קבצים ומסדים — אפשר לקשר בין ספרים של קבצים או מסדים שונים.` : ""}`);
      this.chooseRoles(opened);
      this.toWorkspace();
    } else if (res.documents.length) this.toWorkspace();
  }

  /**
   * Which opened book goes where: a commentary ("X על Y") is the source and its open base the target;
   * a "הערות…" book is the target of the book it annotates. Falls back to the first opened book.
   */
  private chooseRoles(opened: readonly SourceBook[]): void {
    if (this.view.source.peek() && this.view.target.peek()) return;
    const all = [...this.books.peek().values()].map((b) => this.refOf(b.key));
    // a book already in a reader keeps its place: newly opened books only fill the empty reader, with
    // the kept book's partner if one is open — never a pair of their own (audit F3: opening the
    // database after the commentary put Onkelos in place of the commentary)
    const kept = this.view.source.peek() ?? this.view.target.peek();
    if (kept) {
      const partner = this.partnerOf(kept, opened, all);
      if (partner) (this.view.source.peek() ? this.view.target : this.view.source).value = partner;
      return;
    }
    const pair = pairByTitle(opened.map((b) => this.refOf(b.key)), all).find((p) => p.target);
    const notes = opened.find((b) => b.title.startsWith("הערות"));
    const main = notes && opened.find((b) => b !== notes && notes.title.includes(b.title));
    // the base placed opposite was chosen among editions by a rule (batch.ts resolveBaseKey): the reader is a manual choice, so it
    // is placed, but the user is told which editions there are, so that what they run on it is their choice (V7 §2.8)
    if (pair?.target && pair.undecided?.length && pair.note) this.notify("info", pair.note);
    batch(() => {
      if (pair?.target) (this.view.source.value = pair.source.key), (this.view.target.value = pair.target.key);
      else if (notes && main) (this.view.source.value = main.key), (this.view.target.value = notes.key);
      else this.view.source.value = opened[0]!.key;
    });
  }

  /**
   * The open book that goes opposite `key`: the base its title names ("X על Y"), a newly opened
   * commentary on it, the book a "הערות…" book annotates, or newly opened notes on it. Null when none.
   */
  private partnerOf(key: string, opened: readonly SourceBook[], all: readonly BookRef[]): string | null {
    const self = this.refOf(key);
    const own = pairOne(self, titleIndex(all)).target;
    if (own) return own.key;
    const dependant = pairByTitle(opened.filter((b) => b.key !== key).map((b) => this.refOf(b.key)), all).find((p) => p.target?.key === key);
    if (dependant) return dependant.source.key;
    const fresh = opened.filter((b) => b.key !== key);
    const notesOn = self.title.startsWith("הערות") ? fresh.find((b) => self.title.includes(b.title)) : fresh.find((b) => b.title.startsWith("הערות") && b.title.includes(self.title));
    return notesOn?.key ?? null;
  }

  /**
   * Closes a source and releases what the worker held for it. Not while a task runs (a drop being opened, an
   * engine, a max-link job: the worker may be reading this very source): the user is told and nothing closes.
   * Returns whether it closed (#22).
   */
  async closeSource(id: string): Promise<boolean> {
    const s = this.sources.value.find((x) => x.info.id === id);
    if (!s) return true;
    if (this.running.length > 0 || this.maxLink.running.peek()) {
      this.notify("warning", `"${s.info.label}" בשימוש עכשיו: עבודה רצה על הספרים הפתוחים. חכו שתסתיים (או בטלו אותה) ונסו לסגור שוב.`);
      return false;
    }
    await this.service.close(id);
    this.dbLinks.forgetSummary();
    batch(() => {
      this.sources.value = this.sources.value.filter((x) => x.info.id !== id);
      // the links keep their books by title, as after a worker restart: a key of the closed source names
      // nothing now — the reader would not show them on the same book opened again (its key is new), and
      // the check would take the book for open. attachLinks binds them to the book when it opens again.
      this.linkState.value = rebindLinks(this.linkState.value, (l) => {
        const s = sourceIdOfBookKey(l.source.book.key) === id ? unboundRef(l.source.book) : l.source.book;
        const t = sourceIdOfBookKey(l.target.book.key) === id ? unboundRef(l.target.book) : l.target.book;
        return s === l.source.book && t === l.target.book ? l : { ...l, source: { ...l.source, book: s }, target: { ...l.target, book: t } };
      });
      for (const side of ["source", "target"] as const) {
        if (this.view[side].value?.startsWith(`${id}:`)) this.view[side].value = null;
        if (this.pick[side].value?.bookKey.startsWith(`${id}:`)) this.pick[side].value = null;
      }
    });
    this.lines.forgetSource(id);
    return true;
  }

  /**
   * The worker that held the open sources had to be restarted (it crashed, or stayed busy after a
   * cancel). Its sources are gone; the project's links are not.
   */
  workerLost(reason: string): void {
    this.log.error("worker", "restarted", { reason, sources: this.sources.value.length }, "worker/restarted");
    // the links keep their books by title, as a saved project does: the keys named the lost worker's
    // sources, and attachLinks binds them again to the books opened next (review C2)
    const unbind = unboundRef;
    batch(() => {
      this.sources.value = [];
      this.view.source.value = null;
      this.view.target.value = null;
      this.clearPicks();
      this.task.value = null;
      this.linkState.value = rebindLinks(this.linkState.value, (l) => {
        const s = unbind(l.source.book);
        const t = unbind(l.target.book);
        return s === l.source.book && t === l.target.book ? l : { ...l, source: { ...l.source, book: s }, target: { ...l.target, book: t } };
      });
      // suggestions point at lines of the lost sources: approving one would make a link to nothing
      this.suggestions.run.value = null;
      this.suggestions.current.value = null;
    });
    this.find.source.close();
    this.find.target.close();
    this.lines.forgetAll();
    this.dbLinks.forgetSummary();
    this.notify("warning", `${reason} הקישורים בפרויקט לא נפגעו — פתחו שוב את הספרים כדי להמשיך.`);
  }

  /** A BookRef for a key of an open book (or an unresolved link book). */
  refOf(bookKey: string): BookRef {
    const b = this.books.value.get(bookKey);
    if (b) return { key: b.key, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }) };
    const title = bookKey.startsWith("unresolved:") ? bookKey.slice(11) : bookKey;
    return { key: bookKey, title, origin: "unknown" };
  }

  /**
   * Links imported (or restored) before their books were open name them by title only ("unresolved:",
   * origin unknown). When a book of that name opens they are attached to it — the same resolution an
   * import does when the book is already open (resolveTitle) — so the quality check, the export and the
   * readers see the real book, not "not found in any open source" (product audit F6).
   */
  private attachLinks(): void {
    const memo = new Map<string, BookRef | null>();
    const resolve = (ref: BookRef): BookRef => {
      if (!ref.key.startsWith("unresolved:")) return ref;
      const id = `${ref.origin}\u0000${ref.source ?? ""}\u0000${ref.title}`;
      if (!memo.has(id)) memo.set(id, this.resolveTitle(ref.title, ref.origin, ref.source));
      return memo.get(id) ?? ref;
    };
    this.linkState.value = rebindLinks(this.linkState.value, (l) => {
      const s = resolve(l.source.book);
      const t = resolve(l.target.book);
      return s === l.source.book && t === l.target.book ? l : { ...l, source: { ...l.source, book: s }, target: { ...l.target, book: t } };
    });
    this.exchange.booksOpened();
    this.noticeChangedBooks();
  }

  /** The open book a link's BookRef points at: by key, or by exact title for links imported before the book was open. */
  bookOf(ref: BookRef): SourceBook | undefined {
    const own = this.books.value.get(ref.key);
    if (own || !ref.key.startsWith("unresolved:")) return own;
    // an unresolved book is the open book that resolveTitle would bind — the same rules, so a link that stays unresolved
    // because two editions match is not shown, edited or exported as one of them (V7 PR1 review, finding 2)
    const hit = this.resolveTitle(ref.title, ref.origin, ref.source);
    return hit ? this.books.value.get(hit.key) : undefined;
  }

  sameBook(ref: BookRef, bookKey: string): boolean {
    if (ref.key === bookKey) return true;
    return ref.key.startsWith("unresolved:") && this.bookOf(ref)?.key === bookKey;
  }

  /** The label of the source a book key belongs to (a project's StoredBook.source). */
  sourceLabelOf(bookKey: string): string | undefined {
    const id = sourceIdOfBookKey(bookKey);
    return this.sources.peek().find((s) => s.info.id === id)?.info.label;
  }

  /**
   * The open book a title (or a path_2) names; null when none is open.
   *
   * Without a known origin (an import by title, an old project) a non-personal book is preferred, as
   * before. A saved project knows the origin (and, since V7, the source's label): a personal book binds
   * only to a personal book and a library book only to a library one (#41 B18) — a same-titled book of
   * the other kind is a different book, and the link stays unresolved rather than move to it silently.
   * Several candidates of that origin are told apart by the source label; if it does not decide, the
   * link stays unresolved too (V7 §1.1: no silent binding to another edition).
   */
  resolveTitle(title: string, origin: BookOrigin = "unknown", source?: string): BookRef | null {
    const hits = this.booksByTitle.value.get(title) ?? this.booksByTitle.value.get(titleFromPath2(title));
    if (!hits?.length) return null;
    if (origin === "unknown") {
      const b = hits.find((x) => x.origin !== "personal") ?? hits[0]!;
      return this.refOf(b.key);
    }
    const kin = hits.filter((x) => sameOrigin(origin, x.origin));
    if (kin.length <= 1) return kin[0] ? this.refOf(kin[0].key) : null;
    const labelled = source === undefined ? [] : kin.filter((x) => this.sourceLabelOf(x.key) === source);
    return labelled.length === 1 ? this.refOf(labelled[0]!.key) : null;
  }

  /* ---------------- reading and picking ---------------- */

  /** Shows a line in a reader (opening its book there if needed) and flashes it. */
  reveal(side: Side, bookKey: string, line: number): void {
    batch(() => {
      if (this.view[side].value !== bookKey && this.books.value.has(bookKey)) this.view[side].value = bookKey;
      this.focus[side].value = { line, seq: (this.focus[side].peek()?.seq ?? 0) + 1 };
    });
  }

  /**
   * Shows both ends of a link, and keeps them marked as a suggestion's ends are (suggestions.show): a
   * flash alone faded after a second and left nothing to say which line goes with which (V5 UX audit).
   * Not while a link is open in the builder — the picks are its draft.
   */
  revealLink(l: Link): void {
    const s = this.bookOf(l.source.book);
    const t = this.bookOf(l.target.book);
    const at = (bookKey: string, e: Link["source"]): Pick => ({ bookKey, line: e.line, ...(e.end !== undefined && e.end > e.line && { end: e.end }) });
    batch(() => {
      if (s) this.reveal("source", s.key, l.source.line);
      if (t) this.reveal("target", t.key, l.target.line);
      this.revealedLink.value = this.editing.peek() ? null : l;
      if (this.editing.peek()) return;
      if (s) this.pick.source.value = at(s.key, l.source);
      if (t) this.pick.target.value = at(t.key, l.target);
    });
  }

  showBook(side: Side, bookKey: string): void {
    batch(() => {
      this.view[side].value = bookKey;
      this.activeSide.value = side;
    });
  }

  pickLine(side: Side, bookKey: string, line: number, extend = false): void {
    const cur = this.pick[side].value;
    if (extend && cur && cur.bookKey === bookKey) {
      const lo = Math.min(cur.line, line);
      const hi = Math.max(cur.end ?? cur.line, line, cur.line);
      this.pick[side].value = { bookKey, line: lo, ...(hi > lo && { end: hi }) };
    } else this.pick[side].value = { bookKey, line };
    if (side === "source" && this.editing.value) {
      // a new source line makes the old ref_1 wrong — the sync would move the link back to it (B2)
      const edited = this.linkState.value.links.get(this.editing.value);
      if (edited && !(this.sameBook(edited.source.book, bookKey) && edited.source.line === this.pick.source.value?.line)) this.draftRef1.value = "";
    }
    if (side === "target") {
      // a new target makes the old reference wrong — also while editing (UX review #3)
      const edited = this.editing.value ? this.linkState.value.links.get(this.editing.value) : undefined;
      const sameTarget = edited && this.sameBook(edited.target.book, bookKey) && edited.target.line === this.pick.target.value?.line;
      if (!sameTarget) {
        this.draftHeRef.value = null;
        this.draftRef2.value = "";
      }
    }
    this.activeSide.value = side;
    this.autoType();
  }

  /**
   * A commentary linked to the book it is written on must be declared "source" (stored base →
   * commentary, as the app expects); the reverse direction is "commentary". Decided by the titles
   * ("X על Y"), and only while the user has not chosen a type.
   */
  private autoType(): void {
    const s = this.pick.source.peek();
    const t = this.pick.target.peek();
    if (!s || !t || this.draftTypeTouched.peek() || this.editing.peek()) return;
    const a = this.refOf(s.bookKey).title;
    const b = this.refOf(t.bookKey).title;
    if (titleDeclaresDependencyOn(a, b)) this.draftType.value = "source";
    else if (titleDeclaresDependencyOn(b, a)) this.draftType.value = "commentary";
  }

  pickAnchor(side: Side, bookKey: string, line: number, anchor: Pick["anchor"]): void {
    this.pick[side].value = { bookKey, line, ...(anchor && { anchor }) };
    this.activeSide.value = side;
    this.autoType();
  }

  clearPicks(): void {
    batch(() => {
      this.pick.source.value = null;
      this.pick.target.value = null;
      this.editing.value = null;
      this.draftTypeTouched.value = false;
      this.draftHeRef.value = null;
      this.draftRef1.value = "";
      this.draftRef2.value = "";
    });
  }

  /** heRef_2 when the user did not type one: the database's reference, else "<title> <headings>". */
  autoHeRef(t: Pick): string {
    const book = this.books.value.get(t.bookKey);
    const title = book?.title ?? this.refOf(t.bookKey).title;
    const line = this.lines.peek(t.bookKey, t.line);
    if (line?.heRef?.trim()) return line.heRef;
    const trail: string[] = [];
    let level = 7;
    for (let i = t.line; i >= 0 && i > t.line - 3000 && level > 1; i--) {
      const l = this.lines.peek(t.bookKey, i);
      if (!l) break;
      if (l.heading !== null && l.heading < level) {
        const text = stripTags(l.text).trim();
        if (text && text !== title) trail.unshift(text);
        level = l.heading;
      }
    }
    return trail.length ? `${title} ${trail.join(", ")}` : `${title} ${t.line + 1}`;
  }

  /* ---------------- links ---------------- */

  createFromDraft(): Link | null {
    const d = this.draft.value;
    if (!d || this.draftProblems.value.some((p) => p.severity === "error")) return null;
    if (this.editing.value) {
      const before = this.linkState.value.links.get(this.editing.value);
      if (!before) return null;
      const after: Link = { ...d, status: before.status === "existing" ? "edited" : before.status };
      this.apply("עריכת קישור", [{ id: before.id, before, after }, ...this.trimAround(after, before.id)]);
      this.clearPicks();
      return after;
    }
    const link: Link = { ...d, id: this.newLinkId(), status: "new", provenance: "user" };
    this.apply("יצירת קישור", [...addChanges([link]), ...this.trimAround(link)]);
    batch(() => {
      this.pick.target.value = null;
      this.draftHeRef.value = null;
      this.draftRef2.value = "";
      // keep the source pick only when it was a range/anchor the user may link again; else advance to the next line
      const s = this.pick.source.value;
      if (s && !s.anchor && s.end === undefined) this.pick.source.value = { bookKey: s.bookKey, line: this.nextContentLine(s.bookKey, s.line) };
    });
    return link;
  }

  /**
   * v3's "trim the previous range" (F-064): a range of another link that the new link's start falls
   * inside is cut to end one line before it, in the same undoable step, and the user is told.
   */
  private trimAround(link: Link, exclude?: string): Change[] {
    const keyOf = (ref: BookRef) => this.bookOf(ref)?.key;
    const changes: Change[] = [];
    for (const side of ["source", "target"] as const) {
      const key = keyOf(link[side].book);
      if (key) changes.push(...this.ranges.trimFor(key, side, link[side].line, exclude ?? link.id).filter((c) => !changes.some((x) => x.id === c.id)));
    }
    if (changes.length) this.notify("info", changes.length === 1 ? "טווח של קישור קודם קוצר כדי שלא יבלע את הקישור החדש." : `קוצרו הטווחים של ${linksCount(changes.length)} קודמים כדי שלא יבלעו את הקישור החדש.`);
    return changes;
  }

  /** The next line after `line` that is not a heading (links to headings are dropped), as far as loaded. */
  private nextContentLine(bookKey: string, line: number): number {
    for (let i = line + 1; i < line + 50; i++) {
      const l = this.lines.peek(bookKey, i);
      if (!l || l.heading === null) return i;
    }
    return line + 1;
  }

  editInBuilder(id: string): void {
    const l = this.linkState.value.links.get(id);
    if (!l || l.provenance === "db") return;
    const sKey = this.bookOf(l.source.book)?.key ?? l.source.book.key;
    const tKey = this.bookOf(l.target.book)?.key ?? l.target.book.key;
    batch(() => {
      this.editing.value = id;
      this.pick.source.value = { bookKey: sKey, line: l.source.line, ...(l.source.end !== undefined && { end: l.source.end }), ...(l.anchor && { anchor: { ...l.anchor, text: "" } }) };
      this.pick.target.value = { bookKey: tKey, line: l.target.line, ...(l.target.end !== undefined && { end: l.target.end }) };
      this.draftType.value = l.declaredType;
      this.draftTypeTouched.value = true;
      this.draftHeRef.value = l.heRef2;
      this.draftRef1.value = l.ref1 ?? "";
      this.draftRef2.value = l.ref2 ?? "";
      if (this.books.value.has(sKey)) this.view.source.value = sKey;
      if (this.books.value.has(tKey)) this.view.target.value = tKey;
    });
  }

  deleteLinks(ids: readonly string[]): void {
    const s = this.linkState.value;
    const changes = ids.map((id) => deleteChange(s, id)).filter((c): c is Change => !!c);
    this.apply(changes.length === 1 ? "מחיקת קישור" : `מחיקת ${linksCount(changes.length)}`, changes);
    if (this.editing.value && ids.includes(this.editing.value)) this.clearPicks();
    // #42 C31: a delete was silent; it says what it did, and an undo is one tap away (the history keeps it too)
    if (changes.length) {
      const at = this.linkState.peek().revision;
      this.notify("info", changes.length === 1 ? "נמחק קישור אחד." : `נמחקו ${linksCount(changes.length)}.`, undefined, {
        label: "ביטול",
        // only while nothing else was done since: an undo later would take back another action
        run: () => void (this.linkState.peek().revision === at && this.undo()),
      });
    }
  }

  restoreLinks(ids: readonly string[]): void {
    const s = this.linkState.value;
    const changes = ids.map((id) => restoreChange(s, id)).filter((c): c is Change => !!c);
    this.apply(changes.length === 1 ? "שחזור קישור" : `שחזור ${linksCount(changes.length)}`, changes);
  }

  setType(ids: readonly string[], declaredType: string): void {
    const s = this.linkState.value;
    const changes = ids.map((id) => editChange(s, id, { declaredType })).filter((c): c is Change => !!c);
    this.apply(changes.length === 1 ? "שינוי סוג קשר" : `שינוי סוג הקשר של ${linksCount(changes.length)}`, changes);
  }

  /** Removes the word anchor of links (the remedy the quality check offers for an anchor the library refuses). */
  dropAnchors(ids: readonly string[]): void {
    const s = this.linkState.value;
    const changes = ids
      .map((id): Change | null => {
        const before = s.links.get(id);
        if (!before?.anchor || before.provenance === "db") return null;
        const { anchor: _a, ...rest } = before;
        return { id, before, after: { ...rest, status: before.status === "existing" ? "edited" : before.status } };
      })
      .filter((c): c is Change => !!c);
    this.apply(changes.length === 1 ? "הסרת עוגן" : `הסרת העוגן של ${linksCount(changes.length)}`, changes);
  }

  undo(): void {
    this.linkState.value = undo(this.linkState.value);
  }

  redo(): void {
    this.linkState.value = redo(this.linkState.value);
  }

  /** Undoes or redoes to a point of the history list (`position` actions applied). */
  goToHistory(position: number): void {
    this.linkState.value = travel(this.linkState.value, position);
  }

  /** Links touching a book, from the project (not database links). */
  linksOfBook(bookKey: string): Link[] {
    return this.allLinks.value.filter((l) => this.sameBook(l.source.book, bookKey) || this.sameBook(l.target.book, bookKey));
  }

  /* ---------------- databases in someone else's schema (mapping wizard) ---------------- */

  /** databases waiting for the mapping wizard; the dialog shows the first */
  readonly pendingDbs = signal<PendingDb[]>([]);
  /** confirmed mappings by schema fingerprint — saved in the project, reused when the schema comes back */
  readonly dbMappings = signal<ReadonlyMap<string, SavedDbMapping>>(new Map());
  /** the pending entry each mapped source was opened from, so it can be mapped again */
  private readonly mappedFrom = new Map<string, PendingDb>();

  private async offerMappings(list: readonly PendingDb[]): Promise<void> {
    for (const p of list) {
      const saved = this.dbMappings.value.get(p.preview.fingerprint)?.mapping;
      if (saved && !mappingProblems(p.preview, saved).some((x) => x.level === "error") && (await this.openMapped(p, saved))) {
        this.notify("info", `${p.label}: נפתח לפי המיפוי השמור בפרויקט (${describeMapping(saved)}). לשינוי: "מיפוי" ברשימת הקבצים והמסדים.`);
        continue;
      }
      this.pendingDbs.value = [...this.pendingDbs.value.filter((x) => x.token !== p.token), p];
    }
  }

  /** Opens a pending database through a mapping. False (with a notice) when it failed — the wizard stays open. */
  async openMapped(p: PendingDb, mapping: DbMapping): Promise<boolean> {
    const src = await this.runTask(`פותח את ${p.label} לפי המיפוי…`, (opts) => this.service.openMapped(p.token, mapping, opts));
    if (!src) return false;
    this.mappedFrom.set(src.info.id, p);
    batch(() => {
      this.pendingDbs.value = this.pendingDbs.value.filter((x) => x.token !== p.token);
      this.dbMappings.value = new Map(this.dbMappings.value).set(p.preview.fingerprint, { fingerprint: p.preview.fingerprint, label: p.label, mapping });
      this.sources.value = [...this.sources.value, src];
      for (const w of src.info.warnings) this.notify("warning", `${src.info.label}: ${w.message}`);
    });
    this.attachLinks();
    if (src.books.length) {
      this.notify("success", `${booksOpened(src.books.length)} מ־"${src.info.label}".`);
      this.chooseRoles(src.books);
    }
    this.toWorkspace();
    return true;
  }

  /**
   * The wizard's "בדיקת המיפוי": the first lines of the first books, read through a mapping that is
   * not confirmed yet. Bounded (the worker reads the start of each table only), so no task bar; an
   * error comes back as text for the wizard to show next to the button.
   */
  async testMapping(p: PendingDb, mapping: DbMapping): Promise<MappingTest | { error: string }> {
    if (!this.service.testMapping) return { error: "בדיקת מיפוי אינה זמינה כאן." };
    try {
      return await this.service.testMapping(p.token, mapping);
    } catch (err) {
      return { error: (err as { message?: string }).message ?? String(err) };
    }
  }

  dismissMapping(token: string): void {
    const p = this.pendingDbs.value.find((x) => x.token === token);
    this.pendingDbs.value = this.pendingDbs.value.filter((x) => x.token !== token);
    if (p) this.notify("info", `${p.label} לא נפתח. אפשר לגרור אותו שוב בכל עת.`);
  }

  /** The pending entry a mapped source came from (to show its mapping again). */
  canRemap(sourceId: string): boolean {
    return this.mappedFrom.has(sourceId);
  }

  /** Closes a mapped source and reopens the wizard on it, starting from the mapping it was opened with. */
  async remapSource(sourceId: string): Promise<void> {
    const p = this.mappedFrom.get(sourceId);
    if (!p) return;
    const current = this.dbMappings.value.get(p.preview.fingerprint)?.mapping ?? p.guess;
    if (!(await this.closeSource(sourceId))) return;
    this.mappedFrom.delete(sourceId);
    this.pendingDbs.value = [...this.pendingDbs.value, { ...p, guess: current }];
  }

  /* ---------------- moving links to a new edition (stage 11) ---------------- */

  /** a dialog opened from inside a panel */
  readonly dialog = signal<DialogId | null>(null);
  /** the guide section (heading id) the help opens at */
  readonly helpSection = signal<string | undefined>(undefined);

  openHelp(section?: string): void {
    this.helpSection.value = section;
    this.dialog.value = "help";
  }

  /** Closes a dialog if it is still the open one (a dialog that opened another must not close the new one). */
  closeDialog(id: DialogId): void {
    if (this.dialog.peek() === id) this.dialog.value = null;
  }

  /** Something to show in the workspace: open sources, or links (a restored or imported project). */
  hasWork(): boolean {
    return this.sources.peek().length > 0 || this.linkState.peek().links.size > 0;
  }

  /** A file waiting for a decision shows its dialog (the router names it in the address). */
  readonly pendingDialog = computed<"map-db" | "import-records" | null>(() =>
    this.pendingDbs.value.length ? "map-db" : this.exchange.pendingRecords.value.length ? "import-records" : null,
  );

  /** Back over the mapping wizard or the records dialog: the file is not opened, as with its own "skip". */
  dismissPending(which: "map-db" | "import-records"): void {
    if (which === "map-db") {
      const p = this.pendingDbs.peek()[0];
      if (p) this.dismissMapping(p.token);
    } else if (this.exchange.pendingRecords.peek().length) this.exchange.skipRecords();
  }
  /** the last comparison: the plan for the links, and the aligned lines (the diff view, the mapping file) */
  readonly relink = signal<{ oldKey: string; newKey: string; plan: RelinkPlan; stats: Record<string, number>; diff: EditionDiff; rows: EditionRow[] } | null>(null);

  async planRelinkFor(oldKey: string, newKey: string): Promise<boolean> {
    const diff = await this.runTask("משווה בין המהדורות…", (opts) => this.service.diffBooks(oldKey, newKey, opts));
    if (!diff) return false;
    const oldRef = this.refOf(oldKey);
    const anchored = this.allLinks.value.filter((l) => l.anchor && this.sameBook(l.source.book, oldKey));
    for (const l of anchored) {
      await this.lines.load(oldKey, l.source.line, l.source.line);
      const aligned = diff.to[l.source.line] ?? -1;
      const to = aligned >= 0 ? aligned : (diff.moves.find(([o]) => o === l.source.line)?.[1] ?? -1);
      if (to >= 0) await this.lines.load(newKey, to, to);
    }
    const plan = planRelink({
      links: this.allLinks.value,
      oldBook: oldRef,
      newBook: this.refOf(newKey),
      mapping: { to: Int32Array.from(diff.to), fate: diff.fate },
      moves: diff.moves,
      oldLine: (i) => this.lines.peek(oldKey, i)?.anchorText,
      newLine: (i) => this.lines.peek(newKey, i)?.anchorText,
      isOld: (ref) => this.sameBook(ref, oldKey),
    });
    const edition: EditionDiff = { to: diff.to, fate: diff.fate, moves: diff.moves, newLength: diff.newLength, similarity: diff.similarity };
    this.relink.value = { oldKey, newKey, plan, stats: diff.stats, diff: edition, rows: editionRows(edition) };
    return true;
  }

  /** Saves the line mapping old → new of the last comparison as CSV (linking/edition-map.ts). */
  saveLineMapping(): void {
    const r = this.relink.value;
    if (!r) return;
    this.saver.save(`מיפוי-שורות-${new Date().toISOString().slice(0, 10)}.csv`, lineMappingCsv(r.rows, r.diff), "text/csv");
  }

  /** Applies chosen items of the relink plan as ONE undoable action. */
  applyRelink(items: readonly RelinkItem[]): number {
    const s = this.linkState.value;
    const changes: Change[] = items.filter((i) => i.moved && s.links.has(i.link.id)).map((i) => ({ id: i.link.id, before: s.links.get(i.link.id)!, after: i.moved! }));
    this.apply(`העברת ${linksCount(changes.length)} למהדורה החדשה`, changes);
    return changes.length;
  }

  /* ---------------- the rules context: validation and the library's rules ---------------- */

  /*
   * One context for every check of a link: the builder's live check (draftProblems), the export
   * (exchange.prepareExport) and the quality check (quality.run). It is built from what the store
   * owns — the open books, the loaded lines, the database links (dbLinks) — and the library's rules
   * (its Sefaria titles, the export's purpose), so it stays here rather than in the export module:
   * the builder must not depend on the export to check a link, and the three must never disagree.
   */

  /**
   * Loads the lines at both ends of every link, so the rules can be checked on real lines. Their facts
   * are kept apart from the views' bounded cache (LineStore.loadFacts), and so are the database links
   * read around them (beginCheck): a project that needs more chunks than the cache holds is still
   * checked on every link, never passed as "not verified" because its lines were evicted (review C7).
   */
  async loadLinkLines(label: string): Promise<boolean> {
    const need = new Map<string, Set<number>>();
    for (const l of this.allLinks.value) {
      if (l.status === "deleted") continue;
      for (const side of [l.source, l.target]) {
        const b = this.bookOf(side.book);
        if (!b) continue;
        const set = need.get(b.key) ?? new Set<number>();
        set.add(side.line).add(side.end ?? side.line);
        need.set(b.key, set);
      }
    }
    const chunks = (lines: Set<number>) => new Set([...lines].map((i) => Math.floor(i / CHUNK))).size;
    const total = [...need.values()].reduce((n, s) => n + chunks(s), 0);
    const ok = await this.runTask(label, async (opts) => {
      this.lines.beginCheck();
      // database links around the project's own links: validation reports "already in the database"
      await this.dbLinks.loadAround(this.allLinks.value);
      // the length of each book the saved project recorded, so a changed book is said (export/book-changed)
      await Promise.all([...this.projectBookLines.value.keys()].map((t) => this.resolveTitle(t)).flatMap((ref) => (ref && this.lineCountOf(ref) === undefined ? [this.lines.learnCount(this.bookOf(ref)!.key)] : [])));
      let done = 0;
      for (const [key, lines] of need) await this.lines.loadFacts(key, lines, { signal: opts.signal, onChunk: () => opts.onProgress?.(++done, total) });
      return true;
    });
    return ok === true;
  }

  /**
   * Whether the library's sync and PR gate count a book as Sefaria-owned: its title is in the library's
   * list AND the open book is the library's edition (the rule and why: core/links/sefaria-titles.ts).
   * A ref with a key is that book; a bare title is any open book of that name; none open = the title.
   */
  isSefariaOwned(book: { readonly title: string; readonly key?: string }): boolean {
    return isSefariaOwned(book, this.sefariaTitles.value, this.libraryEdition(book));
  }

  /** Whether the open book a ref names is the library's own edition; undefined when no such book is open. */
  private libraryEdition(book: { readonly title: string; readonly key?: string }): boolean | undefined {
    const exact = book.key !== undefined ? this.books.value.get(book.key) : undefined;
    const editions = exact ? [exact] : (this.booksByTitle.value.get(book.title) ?? []);
    if (!editions.length) return undefined;
    return editions.some((b) => this.isLibrarySource(sourceIdOfBookKey(b.key)));
  }

  /** what the user said about a source, against what was detected at open (SourceInfo.library) */
  readonly libraryOverrides = signal<ReadonlyMap<string, boolean>>(new Map());

  /** Whether an open source holds the library's own books (the official database, a library checkout, or the user says so). */
  isLibrarySource(sourceId: string): boolean {
    return this.libraryChoice(sourceId) ?? this.sources.value.find((s) => s.info.id === sourceId)?.info.library ?? false;
  }

  /**
   * What the user said about a source: in this session, else in the project it was saved in (the
   * source opened again matches the saved one by its files, or by its name and kind). Undefined: never said.
   */
  private libraryChoice(sourceId: string): boolean | undefined {
    const set = this.libraryOverrides.value.get(sourceId);
    if (set !== undefined) return set;
    const saved = this.projectLibraryChoices.value;
    if (!saved.length) return undefined;
    const s = this.sources.value.find((x) => x.info.id === sourceId);
    if (!s) return undefined;
    // the files inside the chosen folder, without the folder's own name: a moved or renamed folder is the
    // same source (V5 P1-10) — the label is the folder's name, so it cannot be what matches
    const files = s.info.kind === "text-files" ? new Set(underRoot(s.books.flatMap((b) => (b.path ? [b.path] : [])))) : null;
    const same = (p: ProjectSource) => {
      const saved = p.files?.length ? underRoot(p.files) : null;
      return p.kind === s.info.kind && (files && saved ? saved.length === files.size && saved.every((f) => files.has(f)) : p.label === s.info.label);
    };
    return saved.find(same)?.library;
  }

  /** The saved project's sources the user had marked (ProjectSource.library), applied when they are open again. */
  private readonly projectLibraryChoices = signal<ProjectSource[]>([]);

  /** The user's switch "ספרי ספריית אוצריא" for one source (product audit F2): decides the Sefaria rules for its books. */
  setLibrarySource(sourceId: string, library: boolean): void {
    const s = this.sources.value.find((x) => x.info.id === sourceId);
    if (!s) return;
    this.libraryOverrides.value = new Map(this.libraryOverrides.value).set(sourceId, library);
    // saved with the project (ProjectSource.library): the project is changed, and autosaved (C10)
    this.linkState.value = touch(this.linkState.value);
    const named = s.books.filter((b) => hasSefariaTitle(b, this.sefariaTitles.value)).map((b) => `"${b.title}"`);
    const which = named.length ? ` ${named.slice(0, 3).join(", ")}${named.length > 3 ? ` ועוד ${named.length - 3}` : ""}` : "";
    this.notify(
      "info",
      library
        ? `"${s.info.label}" מסומן כספרי ספריית אוצריא.${which ? `${which} נחשבים עכשיו ספרי ספריא, ושליחה לספרייה של קישורים אליהם דורשת ציון ספריא.` : ""}`
        : `"${s.info.label}" מסומן כספרים שלכם.${which ? `${which} אינם נחשבים ספרי ספריא.` : ""}`,
    );
  }

  /** Books of a source whose names the library gives to Sefaria books — where the switch above matters. */
  sefariaNamedBooks(sourceId: string): string[] {
    const s = this.sources.value.find((x) => x.info.id === sourceId);
    return s ? s.books.filter((b) => hasSefariaTitle(b, this.sefariaTitles.value)).map((b) => b.title) : [];
  }

  /**
   * Keys of the open books (all, or the given ones) that isSefariaOwned holds for: the same decision,
   * handed to the engines in the worker (core/links/sefaria-owned.ts), so a suggestion never carries
   * what the export refuses on a Sefaria side (product audit F1).
   */
  sefariaOwnedKeys(keys?: Iterable<string>): string[] {
    const out: string[] = [];
    for (const k of keys ?? this.books.value.keys()) if (this.books.value.has(k) && this.isSefariaOwned(this.refOf(k))) out.push(k);
    return out;
  }

  /** The library's own list of Sefaria titles (`.github/data/sefaria_he_titles.txt`) replaces the embedded one. */
  loadSefariaTitles(path: string, text: string): boolean {
    const list = parseSefariaTitles(text, path);
    if (!list) return void this.notify("warning", `"${path}": אין בקובץ שמות ספרים, ולכן הכלי ממשיך עם הרשימה המובנית.`), false;
    this.sefariaTitles.value = list;
    this.notify("info", `נטענה רשימת ספרי ספריא של הספרייה מ־"${path}" (${list.titles.size.toLocaleString("he")} ספרים). לפיה הכלי קובע איפה נדרש ציון ספריא.`);
    return true;
  }

  validation(): ValidationContext {
    return {
      lineCount: (ref) => {
        const b = this.bookOf(ref);
        return b && (b.lineCount ?? this.lines.count(b.key));
      },
      line: (ref, index): LineFacts | undefined => {
        const b = this.bookOf(ref);
        return b && this.lines.factsAt(b.key, index);
      },
      linksFile: (title) => this.dbLinks.linksFile(title),
      sefariaOwned: (book) => this.isSefariaOwned(book),
      sefariaTitle: (book) => hasSefariaTitle(book, this.sefariaTitles.value),
      purpose: this.exportPurpose.value,
      // a text book of the user's goes into a personal-books folder; every other book is found in the
      // official library or in a personal database attached to Otzaria (validate.ts appReverses)
      personalImportSide: (ref) => {
        const b = this.bookOf(ref);
        const src = b && this.sources.value.find((x) => x.info.id === sourceIdOfBookKey(b.key));
        if (!src) return undefined;
        return src.info.kind === "text-files" && !this.isLibrarySource(src.info.id) ? "personal" : "other";
      },
      libraryHasTitle: (ref) => {
        const b = this.bookOf(ref);
        if (!b || this.isLibrarySource(sourceIdOfBookKey(b.key))) return false;
        return (this.booksByTitle.value.get(ref.title) ?? []).some((x) => x.key !== b.key && this.isLibrarySource(sourceIdOfBookKey(x.key)));
      },
      // the database mark (wide: Sefaria's and automatic links count); a file of that name in the library's list holds
      // separately, in validateLink, for the library purpose only
      libraryMayHaveFile: (title) => !!this.booksByTitle.value.get(title)?.some((b) => b.hasSourceLinks),
      libraryFileListed: (title) => embeddedLibraryLinkFiles().titles.has(title),
      libraryFileListLabel: embeddedLibraryLinkFiles().label,
      existing: (l) => this.dbLinks.matchDb(l),
      bookChanged: (ref) => {
        const saved = this.projectBookLines.value.get(ref.title);
        if (saved === undefined) return undefined;
        const now = this.lineCountOf(ref);
        return now !== undefined && now !== saved ? { saved, now } : undefined;
      },
    };
  }

  /* ---------------- projects, autosave, recovery ---------------- */

  /**
   * How many lines each book had when the open project was saved (ProjectFile.bookLines, V5 P1-10). A book
   * open now with another count has changed, and the links on it may point at other lines: the check
   * and the export warn (export/book-changed) until the user says the links were checked (acceptBookChange).
   */
  readonly projectBookLines = signal<ReadonlyMap<string, number>>(new Map());
  /** the changed books already announced in a notice, so it is said once per project */
  private readonly changedNoticed = new Set<string>();
  /** books whose unknown length was asked for (LineStore.learnCount), so it is asked once */
  private readonly countAsked = new Set<string>();

  /** The number of lines of the open book a ref names, when known (databases up front, text files once read). */
  private lineCountOf(ref: BookRef): number | undefined {
    const b = this.bookOf(ref);
    return b && (b.lineCount ?? this.lines.count(b.key));
  }

  /**
   * Says once which books of the project changed since it was saved (they may have moved its links). A
   * text book does not know its length until read: it is learned in the background, then said.
   */
  private noticeChangedBooks(): void {
    const changed: string[] = [];
    const learn: Promise<unknown>[] = [];
    for (const [title, saved] of this.projectBookLines.value) {
      if (this.changedNoticed.has(title)) continue;
      const ref = this.resolveTitle(title);
      const now = ref ? this.lineCountOf(ref) : undefined;
      if (ref && now === undefined && !this.countAsked.has(ref.key)) {
        this.countAsked.add(ref.key);
        learn.push(this.lines.learnCount(ref.key));
      }
      if (now === undefined || now === saved) continue;
      this.changedNoticed.add(title);
      changed.push(`"${title}": היו ${saved.toLocaleString("he")} שורות, עכשיו ${now.toLocaleString("he")}`);
    }
    if (learn.length) void Promise.all(learn).then(() => this.noticeChangedBooks());
    if (!changed.length) return;
    this.notify(
      "warning",
      `${changed.length === 1 ? "ספר אחד השתנה" : `${changed.length.toLocaleString("he")} ספרים השתנו`} מאז שהפרויקט נשמר, והקישורים עליהם שמורים לפי מספר שורה: ייתכן שחלקם מצביעים עכשיו על שורות אחרות. הבדיקה מסמנת אותם ("הספר השתנה"). אם יש לכם את המהדורה הקודמת, העבירו את הקישורים ב"השוואת מהדורות".`,
      changed,
    );
  }

  /**
   * The user checked the links of books that changed since the project was saved: their present line
   * count becomes the project's (saved with it), and the warning goes. Marks the project changed.
   */
  acceptBookChange(titles: readonly string[]): void {
    const next = new Map(this.projectBookLines.value);
    let changed = false;
    for (const t of titles) {
      const ref = this.resolveTitle(t);
      const now = ref ? this.lineCountOf(ref) : undefined;
      if (now === undefined || next.get(t) === undefined || next.get(t) === now) continue;
      next.set(t, now);
      changed = true;
    }
    if (!changed) return;
    this.projectBookLines.value = next;
    this.linkState.value = touch(this.linkState.value);
  }

  /** The line counts the project saves: as saved before for a book the user did not accept as changed, else as open now. */
  private bookLinesNow(): { title: string; lines: number }[] {
    const saved = this.projectBookLines.value;
    const out = new Map<string, number>();
    for (const l of this.allLinks.value) {
      if (l.provenance === "db") continue;
      for (const side of [l.source, l.target]) {
        const t = side.book.title;
        if (out.has(t)) continue;
        const n = saved.get(t) ?? this.lineCountOf(side.book);
        if (n !== undefined) out.set(t, n);
        else {
          // a text book does not know its length until read: learned now, saved with the next autosave
          const b = this.bookOf(side.book);
          if (b && !this.countAsked.has(b.key)) (this.countAsked.add(b.key), void this.lines.learnCount(b.key));
        }
      }
    }
    return [...out].map(([title, lines]) => ({ title, lines }));
  }

  /** The sources the open project was saved with (audit F10); missingSources lists those not open again. */
  readonly projectSources = signal<ProjectSource[]>([]);

  /**
   * The project's sources that are not open yet, each with the titles its links still wait for. A
   * source that recorded its titles is back when they are all open (whatever source holds them — the
   * links bind by title); an older project's source, by its label.
   */
  readonly missingSources = computed<(ProjectSource & { missingTitles: string[] })[]>(() => {
    const open = this.booksByTitle.value;
    const labels = new Set(this.sources.value.map((s) => s.info.label));
    return this.projectSources.value.flatMap((s) => {
      const missingTitles = (s.titles ?? []).filter((t) => !open.has(t));
      const missing = s.titles?.length ? missingTitles.length > 0 : !labels.has(s.label);
      return missing ? [{ ...s, missingTitles }] : [];
    });
  });

  /** The list of sources to reopen is folded to one line (the user hid it; its button shows it again). */
  readonly missingSourcesFolded = signal(false);

  /** The user does not want to open the project's sources again: the list goes away. */
  dismissMissingSources(): void {
    this.projectSources.value = [];
  }

  /** What a project records of each open source: its files and the titles its links use (audit F10). */
  private projectSourcesNow(): ProjectSource[] {
    const used = new Map<string, Set<string>>();
    for (const l of this.allLinks.value)
      for (const side of [l.source, l.target]) {
        const b = this.bookOf(side.book);
        if (b) used.set(sourceIdOfBookKey(b.key), (used.get(sourceIdOfBookKey(b.key)) ?? new Set()).add(b.title));
      }
    const open = this.sources.value.map((s): ProjectSource => {
      const files = s.info.kind === "text-files" ? s.books.flatMap((b) => (b.path ? [b.path] : [])).slice(0, 5000) : [];
      const titles = [...(used.get(s.info.id) ?? [])].slice(0, 5000);
      const library = this.libraryChoice(s.info.id);
      return { label: s.info.label, kind: s.info.kind, books: s.books.length, ...(files.length && { files }), ...(titles.length && { titles }), ...(library !== undefined && { library }) };
    });
    // a source still missing from the project this one was opened from stays in it: saving before reopening must not forget it
    const labels = new Set(open.map((s) => s.label));
    return [...open, ...this.missingSources.value.filter((s) => !labels.has(s.label)).map(({ missingTitles: _m, ...s }) => s)];
  }

  projectText(): string {
    const titleOf = (k: string | null) => (k ? this.refOf(k).title : null);
    return serializeProject(
      {
        sources: this.projectSourcesNow(),
        links: this.allLinks.value,
        rejectedSuggestions: [...this.suggestions.rejected.value],
        view: { source: titleOf(this.view.source.value), target: titleOf(this.view.target.value) },
        altToc: this.altToc.list.value,
        dbMappings: [...this.dbMappings.value.values()],
        // a confirmation is for this session only (C4): "no file in the library" is not a copy of a file at all
        libraryFiles: [...this.linkState.value.files.values()].filter((f) => f.confirmed !== "none").map((f) => ({ title: f.title, records: f.records, hash: f.hash, ...(f.layout && { layout: f.layout }) })),
        bookLines: this.bookLinesNow(),
        coverage: this.coverage.snapshot(),
        sourceOf: (k) => this.sourceLabelOf(k),
      },
      APP_VERSION,
      undefined,
      this.projectJson,
    );
  }

  /** each link's project JSON, by link object (links are immutable): an autosave re-serializes only what changed (C18) */
  private readonly projectJson = new WeakMap<Link, string>();

  saveProject(): void {
    const t = this.view.source.value ? this.refOf(this.view.source.value).title : "פרויקט";
    // the local date and time in the name (#42 C28): saving again made "(1)", "(2)", and the newest was not to be told
    const d = new Date();
    const p2 = (x: number) => String(x).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}-${p2(d.getMinutes())}`;
    this.saver.save(`${safeFileTitle(t, "פרויקט")} ${stamp}.otzlinker.json`, this.projectText(), "application/json");
    this.savedRevision.value = this.linkState.value.revision;
    this.notify("success", "הפרויקט נשמר. אפשר לפתוח אותו שוב בגרירה לחלון או מהמסך הראשי.");
  }

  /**
   * Opens a saved project, replacing the current links (one undo step back to what was there).
   *
   * Over work that was not saved, that work is kept (#41 B21): in the browser's recovery queue — so a
   * refresh offers it again — and in a notice whose action brings it back. Undo works too, but only until
   * the tab is closed or refreshed.
   */
  openProject(path: string, text: string): void {
    const ls0 = this.linkState.peek();
    const unsaved = this.dirty.peek() && (ls0.links.size > 0 || ls0.altToc.size > 0 || ls0.rejected.size > 0) ? this.projectText() : null;
    let p;
    try {
      p = parseProject(text, (b) => this.resolveTitle(b.title, b.origin, b.source) ?? { key: `unresolved:${b.title}`, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }), ...(b.source !== undefined && { source: b.source }) });
    } catch (err) {
      return void this.notify("error", `"${path}": ${(err as Error).message}`);
    }
    const old = this.linkState.value.links;
    const changes: Change[] = [...old.values()].map((l) => ({ id: l.id, before: l }));
    for (const l of p.links) changes.push({ id: l.id, ...(old.get(l.id) && { before: old.get(l.id)! }), after: l });
    // the project's alt_toc replaces the current one, in the same undoable action
    const ls = this.linkState.value;
    const altChanges: AltTocChange[] = [...ls.altToc.keys()].filter((t) => !p.altToc.some((b) => b.title === t)).map((t) => altTocChange(ls, t, null));
    for (const b of p.altToc) altChanges.push(altTocChange(ls, b.title, b));
    // the project's library files replace the current ones, as UNVERIFIED snapshots: a project is
    // not the library, so each book waits until its file is loaded again or confirmed (A3)
    const fileChanges = [...ls.files.keys()].filter((t) => !p.libraryFiles.some((f) => f.title === t)).map((t) => fileChange(ls, t, null));
    for (const f of p.libraryFiles) fileChanges.push(fileChange(ls, f.title, { ...f, verified: false }));
    batch(() => {
      // the project's rejections replace the current ones, in the same undoable action (C10)
      const rejected = new Set(p.rejectedSuggestions);
      const rejections = { add: rejected, remove: [...ls.rejected].filter((k) => !rejected.has(k)) };
      this.linkState.value = commit(this.linkState.value, `פתיחת פרויקט (${linksCount(p.links.length)})`, changes.filter((c) => c.before !== c.after), Date.now(), altChanges, fileChanges, rejections);
      if (p.dbMappings?.length) this.dbMappings.value = new Map([...this.dbMappings.value, ...p.dbMappings.map((m) => [m.fingerprint, m] as const)]);
      this.savedRevision.value = this.linkState.value.revision;
      const show = (title: string | null) => (title ? this.booksByTitle.value.get(title)?.[0]?.key ?? null : null);
      this.view.source.value = show(p.view.source) ?? this.view.source.value;
      this.view.target.value = show(p.view.target) ?? this.view.target.value;
      this.projectSources.value = p.sources;
      this.projectBookLines.value = new Map(p.bookLines.map((b) => [b.title, b.lines] as const));
      this.coverage.restore(p.coverage);
      this.changedNoticed.clear();
      // the switch "ספרי ספריית אוצריא" as the user left it, for each source when it is open again
      this.projectLibraryChoices.value = p.sources.filter((s) => s.library !== undefined);
      if (this.screen.peek() !== "guided") this.screen.value = "workspace";
    });
    const missing = this.missingSources.value.length;
    // the sources to open again are a list that stays until they are open (sources panel, empty reader) — not a fading notice (audit F10)
    this.notify("success", `נפתח פרויקט מ־${p.savedAt ? new Date(p.savedAt).toLocaleString("he") : "תאריך לא ידוע"}: ${p.links.length.toLocaleString("he")} קישורים.${missing ? ` כדי לראות אותם על הטקסט, פתחו שוב ${missing === 1 ? "את הקובץ או המסד של הפרויקט" : `את ${missing.toLocaleString("he")} הקבצים והמסדים של הפרויקט`} — הרשימה ב"קבצים ומסדים".` : ""}`);
    if (p.skipped) this.notify("warning", `${p.skipped} רשומות פגומות בפרויקט דולגו.`);
    if (unsaved) {
      // kept in the browser too when the autosave runs; if that write fails, the user hears it (V7 PR1 review, finding 5)
      const kept = this.recoveryQueue;
      if (kept)
        void kept.add(unsaved).then((ok) => {
          if (!ok) this.notify("warning", "לא הצלחתי לשמור בדפדפן את העבודה הקודמת שהוחלפה. היא זמינה עדיין בכפתור \"החזרת העבודה הקודמת\" עד שתסגרו את החלון — כדי לא לאבד אותה, החזירו אותה ושמרו אותה לקובץ.");
        });
      const n = recoverableCount(unsaved);
      this.notify("warning", `העבודה הקודמת לא נשמרה (${n.toLocaleString("he")} קישורים והחלטות), והפרויקט "${path}" נפתח במקומה. היא נשמרה בצד: אפשר להחזיר אותה בכפתור כאן${kept ? ", והיא תוצע שוב גם בפתיחה הבאה של הכלי" : " (השמירה האוטומטית בדפדפן אינה פעילה, ולכן אחרי סגירת החלון היא לא תהיה)"}.`, undefined, {
        label: "החזרת העבודה הקודמת",
        run: () => (void this.recoveryQueue?.take(unsaved), this.openProject("העבודה הקודמת", unsaved)),
      });
    }
    this.noticeChangedBooks();
    const snapshots = [...new Set([...p.libraryFiles.map((f) => f.title), ...p.links.filter((l) => l.provenance === "file").map((l) => l.source.book.title)])];
    if (snapshots.length)
      this.notify("info", `בפרויקט יש עותק של קובצי הקישורים של ${snapshots.length === 1 ? `"${snapshots[0]}"` : `${snapshots.length} ספרים`} מהספרייה. לפני ייצוא שלהם טענו אותם שוב מהספרייה (הכלי יוודא שהם לא השתנו), או אשרו בחלון הייצוא שהעותק העדכני.`, snapshots.length > 1 ? snapshots.slice(0, 50) : undefined);
  }

  /** The browser autosave, while startAutosave runs: what the last write did (V7 §1.2: the user sees whether the work is kept). */
  readonly autosave = signal<"idle" | "pending" | "saved" | "failed">("idle");
  /** the recovery queue of the running autosave: opening a project over unsaved work puts that work in it (#41 B21) */
  private recoveryQueue: { add(text: string): Promise<boolean>; take(text: string): Promise<boolean> } | null = null;

  /**
   * Saves the project to the browser a moment after every change, and offers to restore what a
   * crash, refresh or closed tab left behind (stage 14). Returns a disposer.
   *
   * With a `window` (the app always passes one) each window of the tool writes its own key,
   * `autosave:v1:w:<id>`: one IndexedDB serves every window, and a single key let the last write erase
   * the work of the others (#41 B17). The id survives a refresh of the same tab (main.tsx keeps it in
   * sessionStorage), so a refresh is offered that tab's work. What a window that is no longer open left
   * behind — and the single key of older versions — is moved, at start, into the shared recovery queue
   * and offered to the next window that starts; a window still open keeps its own. Without a window (tests
   * of older behaviour) the single key is used as before.
   */
  startAutosave(kv: KeyValueStore, delayMs = 1500, window?: AutosaveWindow): () => void {
    const KEY = window ? `${AUTOSAVE_KEY}:w:${window.id}` : AUTOSAVE_KEY;
    const RECOVERED = `${AUTOSAVE_KEY}:recovered`;
    const exclusive = <T>(fn: () => Promise<T>): Promise<T> => (window?.exclusive ? window.exclusive(fn) : fn());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    /** the revision last written: the state changes without a new revision (books bound to links) are not written again */
    let written = this.linkState.peek().revision;
    let reported = false;
    const stop = effect(() => {
      const rev = this.linkState.value.revision;
      if (first) return void (first = false);
      clearTimeout(timer);
      this.autosave.value = "pending";
      timer = setTimeout(() => {
        const ls = this.linkState.peek();
        if (ls.revision === written) return void (this.autosave.value = "saved");
        written = ls.revision;
        const empty = ls.links.size === 0 && ls.altToc.size === 0 && ls.rejected.size === 0;
        (empty ? kv.delete(KEY) : kv.set(KEY, this.projectText())).then(
          () => {
            if (written === ls.revision) this.autosave.value = "saved";
            reported = false;
          },
          (err: unknown) => {
            // storage blocked or full: the next change tries again, and the user hears of it once (not per change)
            written = -1;
            this.autosave.value = "failed";
            this.log.error("autosave.failed", String((err as Error | undefined)?.message ?? err));
            if (!reported) this.notify("warning", "השמירה האוטומטית בדפדפן נכשלה (ייתכן שהאחסון מלא או חסום). העבודה עדיין פתוחה כאן — שמרו את הפרויקט לקובץ כדי לא לאבד אותה.");
            reported = true;
          },
        );
      }, delayMs);
      void rev;
    });
    /*
     * What a crash, refresh or closed tab left behind is offered once the app starts empty. An offer the
     * user did not answer (they went on working without restoring or dismissing it) is kept aside
     * (`:recovered`), so the autosave of the new work cannot overwrite it (UX review #4) — and it is offered
     * again at the next start, after the newer work: never left in storage where nothing would offer it.
     * The queue is shared by the windows: each change of it reads it again inside `exclusive`, so two
     * windows never write back each other's stale copy.
     */
    // one change at a time in this window too (a dismiss and a restore in a row would each write back the other's copy)
    let chain: Promise<void> = Promise.resolve();
    /*
     * The queue holds MAX_RECOVERY_OFFERS texts; what does not fit is never dropped (V7 PR1 review, finding 3: a fourth closed
     * window's work was deleted). It is put back in a key of its own, `<key>:w:spill-…`, which no live window owns: a later
     * start moves it into the queue when there is room, like a closed window's key.
     */
    let spills = 0;
    const spill = async (texts: readonly string[]) => {
      for (const t of texts) await kv.set(`${AUTOSAVE_KEY}:w:spill-${Date.now().toString(36)}-${(spills++).toString(36)}`, t);
    };
    /** true when the change reached the browser's storage (V7 PR1 review, finding 5: a failure was swallowed while the user was told the work is kept) */
    const update = (change: (list: string[]) => string[]): Promise<boolean> => {
      const done = chain.then(() =>
        exclusive(async () => {
          const all = change(keptOffers(await kv.get(RECOVERED)));
          const next = all.slice(0, MAX_RECOVERY_OFFERS);
          await spill(all.slice(MAX_RECOVERY_OFFERS));
          await (next.length ? kv.set(RECOVERED, JSON.stringify(next)) : kv.delete(RECOVERED));
        }).then(
          () => true,
          () => false,
        ),
      );
      chain = done.then(() => {});
      return done;
    };
    const take = (text: string) => update((list) => list.filter((t) => t !== text));
    const add = (text: string) => update((list) => [text, ...list.filter((t) => t !== text)]);
    this.recoveryQueue = { add, take };
    const offer = (queue: readonly string[]) => {
      const [text, ...rest] = queue;
      if (text === undefined) return void (this.recovery.value = null);
      this.recovery.value = {
        links: recoverableCount(text),
        // the restored work is the project now (this window's autosave keeps it); the other offers wait for the next start
        restore: () => (void take(text), this.openProject("שמירה אוטומטית", text), (this.recovery.value = null)),
        dismiss: () => (void take(text), offer(rest)),
      };
    };
    void exclusive(async () => {
      const own = await kv.get(KEY);
      /* the work of windows that are gone (and the single key of older versions, and spilled texts): their keys, found first */
      const orphanKeys: string[] = [];
      if (window) {
        const live = await window.live().catch(() => null);
        const keys = ((await kv.keys?.().catch(() => [] as string[])) ?? []).sort();
        for (const k of keys) {
          const id = k.startsWith(`${AUTOSAVE_KEY}:w:`) ? k.slice(AUTOSAVE_KEY.length + 3) : k === AUTOSAVE_KEY ? "" : null;
          if (id === null || id === window.id) continue;
          // a window that may still be open keeps its key: without the browser's answer only the old single key and spills move
          if (id !== "" && !id.startsWith("spill-") && (!live || live.has(id))) continue;
          orphanKeys.push(k);
        }
      }
      // read last: what other windows (or this one) changed in the queue meanwhile is in it
      const queue: string[] = [];
      for (const text of [own, ...keptOffers(await kv.get(RECOVERED))]) if (text && !queue.includes(text) && recoverableCount(text) > 0) queue.push(text);
      // more than fits (this window's own work came in front of a full queue): the rest waits in spill keys, not dropped
      await spill(queue.splice(MAX_RECOVERY_OFFERS));
      // the orphans join while there is room; the others stay in their keys for a later start (V7 PR1 review, finding 3)
      for (const k of orphanKeys) {
        const text = await kv.get(k);
        const useful = !!text && recoverableCount(text) > 0;
        if (useful && !queue.includes(text!)) {
          if (queue.length >= MAX_RECOVERY_OFFERS) continue;
          queue.push(text!);
        }
        await kv.delete(k);
      }
      await (queue.length ? kv.set(RECOVERED, JSON.stringify(queue)) : kv.delete(RECOVERED));
      return queue;
    }).then(
      (queue) => {
        if (this.linkState.peek().links.size || this.linkState.peek().altToc.size || this.linkState.peek().rejected.size) return;
        if (queue.length) offer(queue);
      },
      () => {},
    );
    return () => (clearTimeout(timer), stop(), (this.recoveryQueue = null));
  }

  /* ---------------- notices and tasks ---------------- */

  /** diagnostics (see diagnostics.ts): notices, tasks, worker restarts and uncaught errors */
  readonly log = diagnosticsLog();

  /** Saves the diagnostic log as JSONL, with a header describing the app and what is open (no book content). */
  saveDiagnostics(): void {
    const header = {
      app: __APP_VERSION__,
      commit: __APP_COMMIT__,
      built: __APP_BUILD_DATE__,
      savedAt: new Date().toISOString(),
      userAgent: globalThis.navigator?.userAgent ?? "",
      sources: this.sources.value.map((s) => ({ kind: s.info.kind, books: s.books.length })),
      links: this.linkState.value.links.size,
      prefs: { theme: this.prefs.theme.value, advanced: this.prefs.advanced.value, createMode: this.prefs.createMode.value, view: this.prefs.suggestionsView.value, layout: this.prefs.layout.value.preset },
    };
    this.saver.save(diagnosticsFileName(), diagnosticsFile(header, this.log.entries()), "application/x-ndjson");
  }

  /** shows a notice; its id lets the module that raised it take it back when it no longer holds (U20) */
  notify(kind: NoticeKind, text: string, details?: string[], action?: Notice["action"], sticky?: boolean): number {
    logNotice(this.log, kind, text, details);
    const n: Notice = { id: ++this.noticeSeq, kind, text, ...(details && { details }), ...(action && { action }), ...(sticky && { sticky }) };
    this.notices.value = [...this.notices.value, n].slice(-6);
    return n.id;
  }

  dismiss(id: number): void {
    this.notices.value = this.notices.value.filter((n) => n.id !== id);
  }

  /**
   * Tasks that run now, oldest first. Two can overlap (a drop of files while an engine runs); `task`
   * shows the latest, and a task that ends shows the one before it again — it never clears the slot
   * while another still runs, which hid that one's progress and its cancel (review C16).
   */
  private readonly running: { task: Task }[] = [];

  private showTask(): void {
    this.task.value = this.running.at(-1)?.task ?? null;
  }

  /** Runs a long task with a cancel and progress; `count` turns the progress into the task's own units (audit F21). */
  async runTask<T>(label: string, run: (opts: { signal?: AbortSignal; onProgress?: (d: number, t: number) => void }) => Promise<T>, count?: (done: number, total: number) => string): Promise<T | null> {
    const ac = new AbortController();
    const logged = logTask(this.log, label);
    const startedAt = Date.now();
    const mine = { task: { label, done: 0, total: 0, cancel: () => ac.abort(), startedAt } as Task };
    this.running.push(mine);
    this.showTask();
    try {
      const result = await run({
        signal: ac.signal,
        onProgress: (done, total) => {
          mine.task = { label, done, total, cancel: () => ac.abort(), startedAt, ...(count && total > 0 && { count: count(done, total) }) };
          if (this.running.at(-1) === mine) this.task.value = mine.task;
        },
      });
      logged.ok();
      return result;
    } catch (err) {
      const e = err as { code?: string; message?: string; name?: string };
      if (e.code === "cancelled" || e.name === "AbortError") (logged.cancelled(), this.notify("info", "הפעולה בוטלה. שום דבר לא השתנה."));
      else (logged.failed(err), this.notify("error", e.message ?? String(err)));
      return null;
    } finally {
      const i = this.running.indexOf(mine);
      if (i >= 0) this.running.splice(i, 1);
      this.showTask();
    }
  }

  private apply(label: string, changes: Change[]): void {
    this.linkState.value = commit(this.linkState.value, label, changes);
  }

  /** true for a link the open database already holds on the same two lines (the ranges module's "continue", #44) */
  inDatabase(l: Link): boolean {
    return this.dbLinks.matchDb(l) !== null;
  }

  /** a fresh id for a link the user makes (the builder; the ranges module's "continue", #44) */
  newLinkId(): string {
    return `u:${Date.now().toString(36)}:${(++this.linkSeq).toString(36)}`;
  }
}

declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

export const TYPE_CHOICES = AUTHORABLE_TYPES.map((t) => t.toLowerCase());
export const isKnownType = (raw: string): boolean => parseConnectionType(raw).known;

/** A book ref by title only ("unresolved:"), as a saved project holds it: attachLinks binds it when a book of that title opens. */
function unboundRef(ref: BookRef): BookRef {
  return ref.key.startsWith("unresolved:") ? ref : { key: `unresolved:${ref.title}`, title: ref.title, origin: ref.origin, ...(ref.isBaseBook !== undefined && { isBaseBook: ref.isBaseBook }) };
}

/** at most this many unanswered recovery offers are kept (each is a whole project) */
const MAX_RECOVERY_OFFERS = 3;
/** the browser autosave's key; each window writes `<key>:w:<window id>` (startAutosave) */
export const AUTOSAVE_KEY = "autosave:v1";

/** The window the autosave runs in (main.tsx: a Web Locks lock per window). */
export interface AutosaveWindow {
  /** this window's id, kept across a refresh of the same tab */
  readonly id: string;
  /** the ids of the windows of the tool that are open now (this one included); null when the browser cannot tell */
  live(): Promise<ReadonlySet<string> | null>;
  /** runs `fn` while no other window runs one (Web Locks); absent: `fn` runs at once */
  exclusive?<T>(fn: () => Promise<T>): Promise<T>;
}

/** links, alt_toc books and rejections a saved project text holds; 0 when it is not one */
function recoverableCount(text: string): number {
  try {
    const saved = JSON.parse(text) as { links?: unknown[]; altToc?: unknown[]; rejectedSuggestions?: unknown[] };
    return (saved.links?.length ?? 0) + (saved.altToc?.length ?? 0) + (saved.rejectedSuggestions?.length ?? 0);
  } catch {
    return 0;
  }
}

/** The unanswered offers kept aside: a list of project texts (an older version kept one text). */
function keptOffers(kept: string | null | undefined): string[] {
  if (!kept) return [];
  try {
    const v = JSON.parse(kept) as unknown;
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
  return [kept];
}

/** Paths inside their common top folder, when they all have one ("ביאורים/א.txt" → "א.txt"); else as they are. */
function underRoot(paths: readonly string[]): string[] {
  const roots = new Set(paths.map((p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : "")));
  return roots.size === 1 && !roots.has("") ? paths.map((p) => p.slice(p.indexOf("/") + 1)) : [...paths];
}
