import { pushTo } from "../core/collections";
import { batch, computed, effect, signal, type ReadonlySignal } from "@preact/signals";
import { parseProject, serializeProject, type ProjectSource } from "../projects/project-format";
import { sourceIdOfBookKey, type SourceBook } from "../core/books";
import { describeMapping, mappingProblems, type DbMapping, type PendingDb, type SavedDbMapping } from "../core/db-mapping";
import { AUTHORABLE_TYPES, parseConnectionType } from "../core/links/connection-type";
import type { BookRef, Link, LinkSide, RawAnchor } from "../core/links/model";
import { path2ForTitle, titleDeclaresDependencyOn, titleFromPath2 } from "../core/links/titles";
import { validateLink, type LineFacts, type Problem, type ValidationContext } from "../core/links/validate";
import { dropStalePipelineFields } from "../core/links/pipeline-fields";
import { sefariaRefFromHeRef } from "../core/links/sefaria-ref";
import { embeddedSefariaTitles, hasSefariaTitle, isSefariaOwned, parseSefariaTitles, type SefariaTitles } from "../core/links/sefaria-titles";
import { stripTags } from "../core/text/html";
import type { EngineId } from "../linking/automatic";
import { pairByTitle, pairOne, titleIndex } from "../linking/batch";
import { addChanges, altTocChange, commit, deleteChange, editChange, emptyLinkState, fileChange, linksCount, rebindLinks, redo, restoreChange, travel, undo, type AltTocChange, type Change, type LinkState } from "./history";
import { AltTocState } from "./alt-toc";
import { CHUNK, LineStore } from "./lines";
import { BookFind } from "./book-find";
import { planRelink, type RelinkItem, type RelinkPlan } from "../linking/relink";
import { editionRows, lineMappingCsv, type EditionDiff, type EditionRow } from "../linking/edition-map";
import { loadPreferences, type Preferences } from "./preferences";
import type { DialogId, SuggestMode } from "./router";
import { diagnosticsFile, diagnosticsFileName, diagnosticsLog, logNotice, logTask } from "./diagnostics";
import { DbLinksState } from "./db-links";
import { RangesState } from "./ranges";
import type { BooksService, InputFile, KeyValueStore, OpenedSource, Saver } from "./services";
import { MaxLinkState } from "./maxlink";
import { SuggestionsState } from "./suggestions";
import { ExchangeState } from "./exchange";
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

export class AppStore {
  readonly prefs: Preferences;
  readonly lines: LineStore;
  /** the search box of each reader */
  readonly find: Record<Side, BookFind>;
  /** alternative TOC structures (alt_toc) of the project */
  readonly altToc: AltTocState;
  /** links the open databases already have: list, per-line view, copying into the project (stage 10) */
  readonly dbLinks: DbLinksState;
  /** max-link: plan, run and report (state/maxlink.ts) */
  readonly maxLink: MaxLinkState;
  /** range suggestions, cutting and completion (state/ranges.ts) */
  readonly ranges: RangesState;
  /** automatic suggestions: engine, citations and batch runs, and the user's decisions (state/suggestions.ts) */
  readonly suggestions: SuggestionsState;
  /** importing links files, sheets and records; the export (state/exchange.ts) */
  readonly exchange: ExchangeState;
  /** the quality check and its report (state/quality.ts) */
  readonly quality: QualityState;
  /** the guided flow "link a folder to Otzaria" (state/guided-flow.ts, route "#/guided/<step>") */
  readonly guided: GuidedFlowState;

  readonly screen = signal<Screen>("home");
  readonly sources = signal<OpenedSource[]>([]);
  readonly linkState = signal<LinkState>(emptyLinkState());
  readonly view = { source: signal<string | null>(null), target: signal<string | null>(null) };
  readonly pick = { source: signal<Pick | null>(null), target: signal<Pick | null>(null) };
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
    const { anchor: _a, ref1: _r1, ref2: _r2, ...kept } = base ?? ({ id: "draft", status: "new", provenance: "user" } as Link);
    // the Sefaria refs the library's sync needs: typed by the user, else built from the line's heRef (B1)
    const ref1 = this.draftRef1.value.trim() || (this.isSefariaOwned(source.book) ? (sefariaRefFromHeRef(this.lines.peek(s.bookKey, s.line)?.heRef) ?? "") : "");
    const ref2 = this.draftRef2.value.trim() || (this.isSefariaOwned(target.book) ? (sefariaRefFromHeRef(this.lines.peek(t.bookKey, t.line)?.heRef) ?? "") : "");
    const d: Link = {
      ...kept,
      source,
      target,
      declaredType: this.draftType.value,
      // a cleared field falls back to the automatic reference: a blank heRef_2 is never written (B3)
      heRef2: this.draftHeRef.value?.trim() ? this.draftHeRef.value : this.autoHeRef(t),
      ...(s.anchor && { anchor: { rawStart: s.anchor.rawStart, ...(s.anchor.rawEnd !== undefined && { rawEnd: s.anchor.rawEnd }), ...(s.anchor.label && { label: s.anchor.label }) } }),
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
      if (dropped.includes("ref_1") && d.ref1 === undefined) out.push({ code: "edit/ref1-dropped", severity: "warning", message: `שורת המקור השתנתה, ולכן ref_1 הישן ("${base.ref1}") הוסר: הסנכרון של הספרייה היה מחזיר את הקישור לשורה הישנה. כתבו את ציון ספריא של השורה החדשה.` });
      if (dropped.includes("ref_2") && d.ref2 === undefined) out.push({ code: "edit/ref2-dropped", severity: "warning", message: `שורת היעד השתנתה, ולכן ref_2 הישן ("${base.ref2}") הוסר: הסנכרון של הספרייה היה מחזיר את הקישור לשורה הישנה. כתבו את ציון ספריא של השורה החדשה.` });
      const fields = dropped.filter((x) => x.startsWith("anchor_"));
      if (fields.length) out.push({ code: "edit/pipeline-fields-dropped", severity: "info", message: `${fields.join(" ו־")} של הסנכרון השבועי יוסרו מהרשומה, כי העוגן או השורה השתנו.` });
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
    this.maxLink = new MaxLinkState(this, service, saver);
    this.ranges = new RangesState(this, service);
    this.suggestions = new SuggestionsState(this, service);
    this.exchange = new ExchangeState(this, service, saver);
    this.quality = new QualityState(this, saver);
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

  async openFiles(files: InputFile[]): Promise<void> {
    if (!files.length) return;
    const res = await this.runTask(`פותח ${files.length === 1 ? files[0]!.path : `${files.length} קבצים`}…`, (opts) => this.service.open(files, opts));
    if (!res) return;
    this.log.info("open", `${files.length} files`, {
      sources: res.sources.map((s) => ({ kind: s.info.kind, books: s.books.length, warnings: s.info.warnings.map((w) => w.code) })),
      documents: res.documents.map((d) => d.kind),
      skipped: res.skipped.length,
      needsMapping: res.needsMapping?.length ?? 0,
    });
    batch(() => {
      this.sources.value = [...this.sources.value, ...res.sources];
      for (const s of res.sources) for (const w of s.info.warnings) this.notify("warning", `${s.info.label}: ${w.message}`);
    });
    if (res.sources.length) this.attachLinks();
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
    if (res.skipped.length)
      this.notify("warning", `${res.skipped.length} קבצים לא נפתחו.`, res.skipped.map((s) => `${s.path}: ${s.reason}`));
    const opened = res.sources.flatMap((s) => s.books);
    if (opened.length) {
      this.notify("success", `נפתחו ${opened.length.toLocaleString("he")} ספרים מ־${res.sources.map((s) => `"${s.info.label}"`).join(", ")}.${this.sources.value.length > res.sources.length ? ` יחד איתם פתוחים ${this.sources.value.length.toLocaleString("he")} מקורות — אפשר לקשר בין ספרים של מקורות שונים.` : ""}`);
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

  async closeSource(id: string): Promise<void> {
    const s = this.sources.value.find((x) => x.info.id === id);
    if (!s) return;
    await this.service.close(id);
    this.dbLinks.forgetSummary();
    batch(() => {
      this.sources.value = this.sources.value.filter((x) => x.info.id !== id);
      for (const side of ["source", "target"] as const) {
        if (this.view[side].value?.startsWith(`${id}:`)) this.view[side].value = null;
        if (this.pick[side].value?.bookKey.startsWith(`${id}:`)) this.pick[side].value = null;
      }
    });
    this.lines.forgetSource(id);
  }

  /**
   * The worker that held the open sources had to be restarted (it crashed, or stayed busy after a
   * cancel). Its sources are gone; the project's links are not.
   */
  workerLost(reason: string): void {
    this.log.error("worker", "restarted", { reason, sources: this.sources.value.length }, "worker/restarted");
    batch(() => {
      this.sources.value = [];
      this.view.source.value = null;
      this.view.target.value = null;
      this.pick.source.value = null;
      this.pick.target.value = null;
      this.task.value = null;
    });
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
      if (!memo.has(ref.title)) memo.set(ref.title, this.resolveTitle(ref.title));
      return memo.get(ref.title) ?? ref;
    };
    this.linkState.value = rebindLinks(this.linkState.value, (l) => {
      const s = resolve(l.source.book);
      const t = resolve(l.target.book);
      return s === l.source.book && t === l.target.book ? l : { ...l, source: { ...l.source, book: s }, target: { ...l.target, book: t } };
    });
    this.exchange.booksOpened();
  }

  /** The open book a link's BookRef points at: by key, or by exact title for links imported before the book was open. */
  bookOf(ref: BookRef): SourceBook | undefined {
    return this.books.value.get(ref.key) ?? this.booksByTitle.value.get(ref.title)?.[0];
  }

  sameBook(ref: BookRef, bookKey: string): boolean {
    if (ref.key === bookKey) return true;
    const b = this.books.value.get(bookKey);
    return !!b && ref.key.startsWith("unresolved:") && ref.title === b.title;
  }

  /** The open book a title (or a path_2) names, a non-personal one first; null when none is open. */
  resolveTitle(title: string): BookRef | null {
    const hits = this.booksByTitle.value.get(title) ?? this.booksByTitle.value.get(titleFromPath2(title));
    const b = hits?.find((x) => x.origin !== "personal") ?? hits?.[0];
    return b ? this.refOf(b.key) : null;
  }

  /* ---------------- reading and picking ---------------- */

  /** Shows a line in a reader (opening its book there if needed) and flashes it. */
  reveal(side: Side, bookKey: string, line: number): void {
    batch(() => {
      if (this.view[side].value !== bookKey && this.books.value.has(bookKey)) this.view[side].value = bookKey;
      this.focus[side].value = { line, seq: (this.focus[side].peek()?.seq ?? 0) + 1 };
    });
  }

  /** Shows both ends of a link. */
  revealLink(l: Link): void {
    const s = this.bookOf(l.source.book);
    const t = this.bookOf(l.target.book);
    if (s) this.reveal("source", s.key, l.source.line);
    if (t) this.reveal("target", t.key, l.target.line);
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
        this.notify("info", `${p.label}: נפתח לפי המיפוי השמור בפרויקט (${describeMapping(saved)}). לשינוי: "מיפוי" ברשימת המקורות.`);
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
      this.notify("success", `נפתחו ${src.books.length.toLocaleString("he")} ספרים מ־"${src.info.label}".`);
      this.chooseRoles(src.books);
    }
    this.toWorkspace();
    return true;
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
    await this.closeSource(sourceId);
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

  /** Loads the lines at both ends of every link, so the rules can be checked on real lines. */
  async loadLinkLines(label: string): Promise<boolean> {
    const need = new Map<string, Set<number>>();
    for (const l of this.allLinks.value) {
      if (l.status === "deleted") continue;
      for (const side of [l.source, l.target]) {
        const b = this.bookOf(side.book);
        if (!b) continue;
        const set = need.get(b.key) ?? new Set<number>();
        set.add(Math.floor(side.line / CHUNK)).add(Math.floor((side.end ?? side.line) / CHUNK));
        need.set(b.key, set);
      }
    }
    const total = [...need.values()].reduce((n, s) => n + s.size, 0);
    const ok = await this.runTask(label, async (opts) => {
      // database links around the project's own links: validation reports "already in the database"
      await this.dbLinks.loadAround(this.allLinks.value);
      let done = 0;
      for (const [key, chunks] of need)
        for (const c of chunks) {
          opts.signal?.throwIfAborted();
          await this.lines.load(key, c * CHUNK, c * CHUNK);
          opts.onProgress?.(++done, total);
        }
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
    return this.libraryOverrides.value.get(sourceId) ?? this.sources.value.find((s) => s.info.id === sourceId)?.info.library ?? false;
  }

  /** The user's switch "ספרי ספריית אוצריא" for one source (product audit F2): decides the Sefaria rules for its books. */
  setLibrarySource(sourceId: string, library: boolean): void {
    const s = this.sources.value.find((x) => x.info.id === sourceId);
    if (!s) return;
    this.libraryOverrides.value = new Map(this.libraryOverrides.value).set(sourceId, library);
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
    this.notify("info", `נטענה רשימת ספרי ספריא של הספרייה מ־"${path}" (${list.titles.size.toLocaleString("he")} ספרים). לפיה הכלי קובע איפה נדרש ref_1/ref_2.`);
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
        const l = b && this.lines.peek(b.key, index);
        return l ? { exists: l.existsInDb, heading: l.heading, anchorLength: l.anchorText.length, hasNotes: l.anchorText !== l.text || l.text.includes('class="footnote"') } : undefined;
      },
      linksFile: (title) => this.dbLinks.linksFile(title),
      sefariaOwned: (book) => this.isSefariaOwned(book),
      sefariaTitle: (book) => hasSefariaTitle(book, this.sefariaTitles.value),
      purpose: this.exportPurpose.value,
      libraryMayHaveFile: (title) => !!this.booksByTitle.value.get(title)?.some((b) => b.hasSourceLinks),
      existing: (l) => this.dbLinks.matchDb(l),
    };
  }

  /* ---------------- projects, autosave, recovery ---------------- */

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
      return { label: s.info.label, kind: s.info.kind, books: s.books.length, ...(files.length && { files }), ...(titles.length && { titles }) };
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
        libraryFiles: [...this.linkState.value.files.values()].map((f) => ({ title: f.title, records: f.records, hash: f.hash, ...(f.layout && { layout: f.layout }) })),
      },
      APP_VERSION,
    );
  }

  saveProject(): void {
    const t = this.view.source.value ? this.refOf(this.view.source.value).title : "פרויקט";
    this.saver.save(`${t}.otzlinker.json`, this.projectText(), "application/json");
    this.savedRevision.value = this.linkState.value.revision;
    this.notify("success", "הפרויקט נשמר. אפשר לפתוח אותו שוב בגרירה לחלון או מהמסך הראשי.");
  }

  /** Opens a saved project, replacing the current links (one undo step back to what was there). */
  openProject(path: string, text: string): void {
    let p;
    try {
      p = parseProject(text, (b) => this.resolveTitle(b.title) ?? { key: `unresolved:${b.title}`, title: b.title, origin: b.origin, ...(b.isBaseBook !== undefined && { isBaseBook: b.isBaseBook }) });
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
      this.linkState.value = commit(this.linkState.value, `פתיחת פרויקט (${linksCount(p.links.length)})`, changes.filter((c) => c.before !== c.after), Date.now(), altChanges, fileChanges);
      this.suggestions.rejected.value = new Set(p.rejectedSuggestions);
      if (p.dbMappings?.length) this.dbMappings.value = new Map([...this.dbMappings.value, ...p.dbMappings.map((m) => [m.fingerprint, m] as const)]);
      this.savedRevision.value = this.linkState.value.revision;
      const show = (title: string | null) => (title ? this.booksByTitle.value.get(title)?.[0]?.key ?? null : null);
      this.view.source.value = show(p.view.source) ?? this.view.source.value;
      this.view.target.value = show(p.view.target) ?? this.view.target.value;
      this.projectSources.value = p.sources;
      if (this.screen.peek() !== "guided") this.screen.value = "workspace";
    });
    const missing = this.missingSources.value.length;
    // the sources to open again are a list that stays until they are open (sources panel, empty reader) — not a fading notice (audit F10)
    this.notify("success", `נפתח פרויקט מ־${p.savedAt ? new Date(p.savedAt).toLocaleString("he") : "תאריך לא ידוע"}: ${p.links.length.toLocaleString("he")} קישורים.${missing ? ` כדי לראות אותם על הטקסט, פתחו שוב ${missing === 1 ? "את המקור של הפרויקט" : `את ${missing.toLocaleString("he")} המקורות של הפרויקט`} — הרשימה ב"מקורות וספרים".` : ""}`);
    if (p.skipped) this.notify("warning", `${p.skipped} רשומות פגומות בפרויקט דולגו.`);
    const snapshots = [...new Set([...p.libraryFiles.map((f) => f.title), ...p.links.filter((l) => l.provenance === "file").map((l) => l.source.book.title)])];
    if (snapshots.length)
      this.notify("info", `בפרויקט יש עותק של קובצי הקישורים של ${snapshots.length === 1 ? `"${snapshots[0]}"` : `${snapshots.length} ספרים`} מהספרייה. לפני ייצוא שלהם טענו אותם שוב מהספרייה (הכלי יוודא שהם לא השתנו), או אשרו בחלון הייצוא שהעותק העדכני.`, snapshots.length > 1 ? snapshots.slice(0, 50) : undefined);
  }

  /**
   * Saves the project to the browser a moment after every change, and offers to restore what a
   * crash, refresh or closed tab left behind (stage 14). Returns a disposer.
   */
  startAutosave(kv: KeyValueStore, delayMs = 1500): () => void {
    const KEY = "autosave:v1";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const stop = effect(() => {
      const rev = this.linkState.value.revision;
      if (first) return void (first = false);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const empty = this.linkState.peek().links.size === 0 && this.linkState.peek().altToc.size === 0;
        (empty ? kv.delete(KEY) : kv.set(KEY, this.projectText())).catch(() => {
          /* storage blocked or full — autosave is best effort */
        });
      }, delayMs);
      void rev;
    });
    void kv.get(KEY).then(
      (text) => {
        if (!text || this.linkState.peek().links.size || this.linkState.peek().altToc.size) return;
        let n = 0;
        try {
          const saved = JSON.parse(text) as { links?: unknown[]; altToc?: unknown[] };
          n = (saved.links?.length ?? 0) + (saved.altToc?.length ?? 0);
        } catch {
          return;
        }
        if (!n) return;
        // kept aside so the next autosave cannot overwrite it before the user decides (UX review #4)
        void kv.set(`${KEY}:recovered`, text).catch(() => {});
        this.recovery.value = { links: n, restore: () => (this.openProject("שמירה אוטומטית", text), (this.recovery.value = null)), dismiss: () => ((this.recovery.value = null), void kv.delete(`${KEY}:recovered`).catch(() => {})) };
      },
      () => {},
    );
    return () => (clearTimeout(timer), stop());
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

  notify(kind: NoticeKind, text: string, details?: string[], action?: Notice["action"]): void {
    logNotice(this.log, kind, text, details);
    const n: Notice = { id: ++this.noticeSeq, kind, text, ...(details && { details }), ...(action && { action }) };
    this.notices.value = [...this.notices.value, n].slice(-6);
  }

  dismiss(id: number): void {
    this.notices.value = this.notices.value.filter((n) => n.id !== id);
  }

  /** Runs a long task with a cancel and progress; `count` turns the progress into the task's own units (audit F21). */
  async runTask<T>(label: string, run: (opts: { signal?: AbortSignal; onProgress?: (d: number, t: number) => void }) => Promise<T>, count?: (done: number, total: number) => string): Promise<T | null> {
    const ac = new AbortController();
    const logged = logTask(this.log, label);
    const startedAt = Date.now();
    this.task.value = { label, done: 0, total: 0, cancel: () => ac.abort(), startedAt };
    try {
      const result = await run({ signal: ac.signal, onProgress: (done, total) => (this.task.value = { label, done, total, cancel: () => ac.abort(), startedAt, ...(count && total > 0 && { count: count(done, total) }) }) });
      logged.ok();
      return result;
    } catch (err) {
      const e = err as { code?: string; message?: string; name?: string };
      if (e.code === "cancelled" || e.name === "AbortError") (logged.cancelled(), this.notify("info", "הפעולה בוטלה. שום דבר לא השתנה."));
      else (logged.failed(err), this.notify("error", e.message ?? String(err)));
      return null;
    } finally {
      this.task.value = null;
    }
  }

  private apply(label: string, changes: Change[]): void {
    this.linkState.value = commit(this.linkState.value, label, changes);
  }

  private newLinkId(): string {
    return `u:${Date.now().toString(36)}:${(++this.linkSeq).toString(36)}`;
  }
}

declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

export const TYPE_CHOICES = AUTHORABLE_TYPES.map((t) => t.toLowerCase());
export const isKnownType = (raw: string): boolean => parseConnectionType(raw).known;
