import { batch, computed, effect, signal } from "@preact/signals";
import { parseProject, serializeProject } from "../projects/project-format";
import type { SourceBook } from "../core/books";
import { describeMapping, mappingProblems, type DbMapping, type PendingDb, type SavedDbMapping } from "../core/db-mapping";
import { AUTHORABLE_TYPES, parseConnectionType } from "../core/links/connection-type";
import type { BookRef, Link, LinkSide, RawAnchor } from "../core/links/model";
import { path2ForTitle, sourceTitleFromLinksFileName, titleDeclaresDependencyOn, titleFromPath2 } from "../core/links/titles";
import { validateLink, type LineFacts, type Problem, type ValidationContext } from "../core/links/validate";
import { stripTags } from "../core/text/html";
import { recordToLink } from "../formats/links-json/convert";
import { storedKey } from "../core/links/stored-form";
import { CONFIDENCE_ORDER, type Confidence, type EngineId, type EngineResult, type Reason, type Suggestion } from "../linking/automatic";
import { pairByTitle, type BatchPair } from "../linking/batch";
import { planExport, zipBundle, type ExportPlan } from "../formats/links-json/export";
import { parseLinksJson } from "../formats/links-json/parse";
import { parseLinksCsv } from "../formats/links-csv/parse";
import { addChanges, altTocChange, commit, deleteChange, editChange, emptyLinkState, linksCount, redo, restoreChange, travel, undo, type AltTocChange, type Change, type LinkState } from "./history";
import { AltTocState } from "./alt-toc";
import type { AltTocExportPlan } from "../formats/alt-toc/export";
import { buildExportReport, REPORT_FILE_NAME } from "../formats/report/export-report";
import { planSefariaCsv, type SefariaCsvFile } from "../formats/sefaria-csv/write";
import type { BookHeading } from "../core/books";
import { CHUNK, LineStore } from "./lines";
import { BookFind } from "./book-find";
import { qaCsv, runQa, type QaReport } from "../linking/qa";
import { planRelink, type RelinkItem, type RelinkPlan } from "../linking/relink";
import { loadPreferences, type Preferences } from "./preferences";
import { guessRecordsMapping, parseRecords, recordsToLinksFiles, type RecordsMapping, type RecordsTable } from "../formats/records/records";
import { detectLayout, type JsonLayout } from "../formats/links-json/layout";
import { diagnosticsFile, diagnosticsFileName, diagnosticsLog, logNotice, logTask } from "./diagnostics";
import { DbLinksState } from "./db-links";
import { RangesState } from "./ranges";
import type { BooksService, InputFile, KeyValueStore, OpenedSource, Saver } from "./services";
import { MaxLinkState, type MaxLinkRunOptions, type MaxLinkScope } from "./maxlink";
import type { MaxLinkRunInfo } from "../linking/maxlink-report";
import { linePairKey } from "../linking/merge";
import type { MaxLinkPlan } from "../linking/plan";

/*
 * The application state (stage 14, architecture rule 9): signals for what the screens show, and
 * methods for everything a user can do. Screens read signals and call methods; they never change
 * links directly. Links change only through history.commit, so every action is undoable.
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
}

export type Screen = "home" | "workspace";
export type SideTab = "builder" | "links" | "suggestions" | "qa" | "books";

/** What the export dialog shows and saves: the links plan and the alt_toc files. */
export interface ExportBundle extends ExportPlan {
  altToc: AltTocExportPlan;
}

/** One run of an automatic engine and the user's decisions on it. */
export interface SuggestionRun {
  engine: EngineId;
  /** "<source> ← <target>" or "אצווה: N ספרים" */
  label: string;
  result: EngineResult;
  at: number;
  /** a batch run: one summary row per book (paired or not) */
  batch?: BatchRow[];
  /** a max-link run: the plan, every step's outcome and the merge counts (state/maxlink.ts) */
  maxlink?: MaxLinkRunInfo;
}

export interface BatchRow {
  source: BookRef;
  target: BookRef | null;
  /** why the book was not run (unpaired) or failed */
  problem?: string;
  suggestions: number;
  certain: number;
  high: number;
  review: number;
}
/** pending → the user has not decided; approved → a link exists for it; exists → the project already has that link */
export type SuggestionState = "pending" | "approved" | "rejected" | "exists";

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
  readonly run = signal<SuggestionRun | null>(null);
  /** line pairs the open databases already link, for the books of the current run (see linePairKey) */
  readonly dbLinkKeys = signal<ReadonlySet<string>>(new Set());
  /** unsaved work found from a previous session, until the user restores or dismisses it */
  readonly recovery = signal<{ links: number; restore: () => void; dismiss: () => void } | null>(null);
  /** what a home-screen task asked for: the engine and panel to start with (guided tasks) */
  readonly intent = signal<{ engine?: EngineId; batch?: boolean; maxlink?: boolean } | null>(null);
  /** the last quality report; null until the user runs the check */
  readonly qa = signal<QaReport | null>(null);
  /** the link revision the report was made on — a different revision means the report is stale */
  readonly qaRevision = signal(-1);
  /**
   * Rejected suggestions, by a key made of book TITLES and positions (rejectionKey) — session book keys
   * change between sessions, titles do not — so a rejection survives re-runs and saved projects.
   */
  readonly rejected = signal<ReadonlySet<string>>(new Set());
  /** the suggestion shown in the inline/card views */
  readonly currentSuggestion = signal<string | null>(null);
  readonly task = signal<Task | null>(null);
  /** the link revision last written to disk — "unsaved changes" compares against it */
  readonly savedRevision = signal(0);

  readonly books = computed(() => {
    const m = new Map<string, SourceBook>();
    for (const s of this.sources.value) for (const b of s.books) m.set(b.key, b);
    return m;
  });
  readonly booksByTitle = computed(() => {
    const m = new Map<string, SourceBook[]>();
    for (const b of this.books.value.values()) m.set(b.title, [...(m.get(b.title) ?? []), b]);
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
    const ref1 = this.draftRef1.value.trim();
    const ref2 = this.draftRef2.value.trim();
    return {
      ...kept,
      source,
      target,
      declaredType: this.draftType.value,
      heRef2: this.draftHeRef.value ?? this.autoHeRef(t),
      ...(s.anchor && { anchor: { rawStart: s.anchor.rawStart, ...(s.anchor.rawEnd !== undefined && { rawEnd: s.anchor.rawEnd }), ...(s.anchor.label && { label: s.anchor.label }) } }),
      ...(ref1 && { ref1 }),
      ...(ref2 && { ref2 }),
      ...(base && base.target.book.title !== target.book.title && { targetPath: path2ForTitle(target.book.title) }),
    };
  });
  readonly draftProblems = computed<Problem[]>(() => {
    const d = this.draft.value;
    // editing a copied database link is fine; only its EXPORT waits for the book's links file
    const { linksFile: _f, ...ctx } = this.validation();
    return d ? validateLink(d, ctx) : [];
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
    for (const d of res.documents) if (d.kind === "links-json") this.importLinksFile(d.path, d.text);
    for (const d of res.documents) if (d.kind === "links-csv") this.importLinksCsv(d.path, d.text);
    for (const d of res.documents) if (d.kind === "records") this.offerRecords(d.path, d.text);
    for (const d of res.documents) if (d.kind === "alt-toc-json") this.altToc.importFile(d.path, d.text);
    for (const d of res.documents) if (d.kind === "project") this.openProject(d.path, d.text);
    if (res.needsMapping?.length) await this.offerMappings(res.needsMapping); // after projects: they may hold the mapping
    for (const d of res.dictionaries ?? [])
      this.notify("info", `נטען מילון דחיסה ${d.id} (${d.path}). ספרים במסדים פתוחים שדחוסים בו ייקראו עכשיו.`);
    if (res.skipped.length)
      this.notify("warning", `${res.skipped.length} קבצים לא נפתחו.`, res.skipped.map((s) => `${s.path}: ${s.reason}`));
    const opened = res.sources.flatMap((s) => s.books);
    if (opened.length) {
      this.notify("success", `נפתחו ${opened.length.toLocaleString("he")} ספרים מ־${res.sources.map((s) => s.info.label).join(", ")}.`);
      this.chooseRoles(opened);
      this.screen.value = "workspace";
    } else if (res.documents.length) this.screen.value = "workspace";
  }

  /**
   * Which opened book goes where: a commentary ("X על Y") is the source and its open base the target;
   * a "הערות…" book is the target of the book it annotates. Falls back to the first opened book.
   */
  private chooseRoles(opened: readonly SourceBook[]): void {
    if (this.view.source.peek() && this.view.target.peek()) return;
    const all = [...this.books.peek().values()].map((b) => this.refOf(b.key));
    const pair = pairByTitle(opened.map((b) => this.refOf(b.key)), all).find((p) => p.target);
    const notes = opened.find((b) => b.title.startsWith("הערות"));
    const main = notes && opened.find((b) => b !== notes && notes.title.includes(b.title));
    batch(() => {
      if (pair?.target) (this.view.source.value = pair.source.key), (this.view.target.value = pair.target.key);
      else if (notes && main) (this.view.source.value = main.key), (this.view.target.value = notes.key);
      else if (!this.view.source.peek()) this.view.source.value = opened[0]!.key;
    });
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

  /** The open book a link's BookRef points at: by key, or by exact title for links imported before the book was open. */
  bookOf(ref: BookRef): SourceBook | undefined {
    return this.books.value.get(ref.key) ?? this.booksByTitle.value.get(ref.title)?.[0];
  }

  sameBook(ref: BookRef, bookKey: string): boolean {
    if (ref.key === bookKey) return true;
    const b = this.books.value.get(bookKey);
    return !!b && ref.key.startsWith("unresolved:") && ref.title === b.title;
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
    if (line?.heRef) return line.heRef;
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

  /* ---------------- automatic suggestions ---------------- */

  async runEngine(engine: EngineId, sourceKey: string, targetKey: string, options: Record<string, unknown> = {}): Promise<boolean> {
    const source = this.refOf(sourceKey);
    const target = this.refOf(targetKey);
    const result = await this.runTask(`מחפש התאמות: ${source.title} ← ${target.title}…`, (opts) => this.service.runEngine(engine, source, target, options, opts));
    if (!result) return false;
    await this.loadDbLinkKeys([source.key]);
    batch(() => {
      this.run.value = { engine, label: `${source.title} ← ${target.title}`, result, at: Date.now() };
      this.currentSuggestion.value = result.suggestions[0]?.id ?? null;
      this.sideTab.value = "suggestions";
    });
    const c = this.suggestionCounts.value;
    this.notify("success", `נמצאו ${result.suggestions.length.toLocaleString("he")} הצעות: ${c.certain} ודאיות, ${c.high} גבוהות, ${c.possible + c.ambiguous} לבדיקה.`);
    return true;
  }

  /**
   * The citations engine (single book): the references in one book ("(בראשית א, ב)", "ב"ק דף ט:"),
   * linked into whatever books are open. There is no target to pick.
   */
  async runCitations(sourceKey: string, options: Record<string, unknown> = {}): Promise<boolean> {
    const source = this.refOf(sourceKey);
    const result = await this.runTask(`מחפש מראי מקומות: ${source.title}…`, (opts) => this.service.runCitations(source, options, opts));
    if (!result) return false;
    await this.loadDbLinkKeys([source.key]);
    batch(() => {
      this.run.value = { engine: "citations", label: `מראי מקומות: ${source.title}`, result, at: Date.now() };
      this.currentSuggestion.value = result.suggestions[0]?.id ?? null;
      this.sideTab.value = "suggestions";
    });
    const c = this.suggestionCounts.value;
    this.notify("success", `נמצאו ${result.suggestions.length.toLocaleString("he")} מראי מקומות: ${c.certain} ודאיים, ${c.high} בוודאות גבוהה, ${c.possible + c.ambiguous} לבדיקה.`);
    return true;
  }

  /**
   * Batch linking (stage 8.4): every book of one open source (e.g. a folder of commentaries) against
   * the base book its title names, among all open books. Unpaired books are listed with the reason.
   */
  async runBatch(engine: EngineId, sourceId: string, options: Record<string, unknown> = {}): Promise<boolean> {
    const src = this.sources.value.find((s) => s.info.id === sourceId);
    if (!src) return false;
    const commentaries = src.books.map((b) => this.refOf(b.key));
    const bases = [...this.books.value.values()].map((b) => this.refOf(b.key));
    const pairs = pairByTitle(commentaries, bases);
    const runnable = pairs.filter((p): p is BatchPair & { target: BookRef } => p.target !== null);
    if (!runnable.length) {
      this.notify("warning", "לא זוהה ספר בסיס לאף ספר במקור הזה.", pairs.map((p) => `${p.source.title}: ${p.reason}`));
      return false;
    }
    const items = await this.runTask(`קישור אצוותי: ${runnable.length} ספרים…`, (opts) => this.service.runBatch(engine, runnable.map(({ source, target }) => ({ source, target })), options, opts));
    if (!items) return false;
    await this.loadDbLinkKeys(runnable.map((p) => p.source.key));
    const suggestions: Suggestion[] = [];
    const notes: Reason[] = [];
    const rows: BatchRow[] = pairs.map((p) => ({ source: p.source, target: p.target, ...(p.reason && { problem: p.reason }), suggestions: 0, certain: 0, high: 0, review: 0 }));
    for (const it of items) {
      const row = rows.find((r) => r.source.key === it.source.key)!;
      if (it.error) row.problem = it.error;
      for (const sg of it.result?.suggestions ?? []) {
        suggestions.push(sg);
        row.suggestions++;
        if (sg.confidence === "certain") row.certain++;
        else if (sg.confidence === "high") row.high++;
        else row.review++;
      }
      for (const n of it.result?.notes ?? []) notes.push({ code: n.code, text: `${it.source.title}: ${n.text}` });
    }
    batch(() => {
      this.run.value = { engine, label: `אצווה: ${runnable.length} מתוך ${pairs.length} ספרים`, result: { suggestions, notes, unmatched: [] }, at: Date.now(), batch: rows };
      this.currentSuggestion.value = suggestions[0]?.id ?? null;
      this.sideTab.value = "suggestions";
    });
    const failed = rows.filter((r) => r.problem).length;
    this.notify(failed ? "warning" : "success", `האצווה הסתיימה: ${suggestions.length.toLocaleString("he")} הצעות ב־${runnable.length} ספרים${failed ? `; ${failed} ספרים לא קושרו (ראו בטבלת הסיכום)` : ""}.`);
    return true;
  }

  /**
   * The library may already have a suggested link (compatibility review #7): read the database links
   * of the run's source books, so such suggestions show as "already exists" instead of as new.
   */
  private async loadDbLinkKeys(bookKeys: readonly string[]): Promise<void> {
    const keys = new Set<string>();
    for (const key of new Set(bookKeys)) {
      try {
        for (const l of await this.service.existingLinks(key, 0, Number.MAX_SAFE_INTEGER)) keys.add(linePairKey(l));
      } catch {
        /* a source without links (text files) or a read error: nothing to compare with */
      }
    }
    this.dbLinkKeys.value = keys;
  }

  readonly suggestionState = computed(() => {
    const run = this.run.value;
    const m = new Map<string, SuggestionState>();
    if (!run) return m;
    const links = this.linkState.value.links;
    const rejected = this.rejected.value;
    // every other link counts — also one approved from ANOTHER run (another engine, a max-link run), which
    // would otherwise be approved twice; only this run's own approvals are left out
    const ownIds = new Set(run.result.suggestions.map((s) => `auto:${s.id}`));
    const existing = new Set<string>();
    for (const l of links.values()) if (l.status !== "deleted" && !ownIds.has(l.id)) existing.add(linePairKey(l));
    for (const k of this.dbLinkKeys.value) existing.add(k);
    for (const s of run.result.suggestions) {
      const own = links.get(`auto:${s.id}`);
      m.set(s.id, own && own.status !== "deleted" ? "approved" : rejectionKeys(s).some((k) => rejected.has(k)) ? "rejected" : existing.has(linePairKey(s)) ? "exists" : "pending");
    }
    return m;
  });

  readonly suggestionCounts = computed(() => {
    const c: Record<Confidence | SuggestionState, number> = { certain: 0, high: 0, possible: 0, ambiguous: 0, none: 0, pending: 0, approved: 0, rejected: 0, exists: 0 };
    const st = this.suggestionState.value;
    for (const s of this.run.value?.result.suggestions ?? []) {
      c[s.confidence]++;
      c[st.get(s.id) ?? "pending"]++;
    }
    return c;
  });

  suggestionLink(s: Suggestion): Link {
    return {
      id: `auto:${s.id}`,
      status: "new",
      provenance: "auto",
      source: s.source,
      target: s.target,
      declaredType: s.declaredType,
      heRef2: s.heRef2,
      ...(s.anchor && { anchor: s.anchor }),
    };
  }

  approveSuggestions(ids: readonly string[]): number {
    const run = this.run.value;
    if (!run) return 0;
    const st = this.suggestionState.value;
    const want = new Set(ids);
    const links = run.result.suggestions.filter((s) => want.has(s.id) && st.get(s.id) !== "approved" && st.get(s.id) !== "exists").map((s) => this.suggestionLink(s));
    if (!links.length) return 0;
    const ids2 = new Set(links.map((l) => l.id.slice(5)));
    batch(() => {
      this.apply(links.length === 1 ? "אישור הצעה" : `אישור ${links.length.toLocaleString("he")} הצעות`, addChanges(links));
      const keys = new Set(run.result.suggestions.filter((x) => ids2.has(x.id)).flatMap(rejectionKeys));
      if ([...keys].some((k) => this.rejected.value.has(k))) this.rejected.value = new Set([...this.rejected.value].filter((k) => !keys.has(k)));
    });
    return links.length;
  }

  rejectSuggestions(ids: readonly string[]): void {
    const approved = ids.map((id) => `auto:${id}`).filter((id) => this.linkState.value.links.has(id));
    batch(() => {
      if (approved.length) this.apply(approved.length === 1 ? "ביטול אישור של הצעה" : `ביטול אישור של ${approved.length.toLocaleString("he")} הצעות`, approved.map((id) => ({ id, before: this.linkState.value.links.get(id)! })));
      this.rejected.value = new Set([...this.rejected.value, ...this.keysOf(ids)]);
    });
  }

  resetSuggestions(ids: readonly string[]): void {
    const drop = new Set(this.keysOf(ids));
    this.rejected.value = new Set([...this.rejected.value].filter((k) => !drop.has(k)));
  }

  private keysOf(ids: readonly string[]): string[] {
    const want = new Set(ids);
    return (this.run.value?.result.suggestions ?? []).filter((x) => want.has(x.id)).flatMap(rejectionKeys);
  }

  /** Pending suggestions at or above a confidence, e.g. "approve every certain one". */
  pendingAtLeast(level: Confidence): string[] {
    const st = this.suggestionState.value;
    const max = CONFIDENCE_ORDER.indexOf(level);
    return (this.run.value?.result.suggestions ?? []).filter((s) => st.get(s.id) === "pending" && CONFIDENCE_ORDER.indexOf(s.confidence) <= max).map((s) => s.id);
  }

  /** Moves the inline/card view to a suggestion and shows both ends in the readers. */
  showSuggestion(id: string): void {
    const s = this.run.value?.result.suggestions.find((x) => x.id === id);
    if (!s) return;
    batch(() => {
      this.currentSuggestion.value = id;
      // show each end in the reader that already holds its book (a suggestion may run base → commentary)
      const sideOf = (key: string, fallback: Side): Side => (this.view.source.value === key ? "source" : this.view.target.value === key ? "target" : fallback);
      const a = sideOf(s.source.book.key, "source");
      const b: Side = a === "source" ? "target" : "source";
      for (const [side, end] of [[a, s.source], [b, s.target]] as const) {
        this.pick[side].value = { bookKey: end.book.key, line: end.line, ...(end.end !== undefined && { end: end.end }) };
        this.reveal(side, end.book.key, end.line);
      }
    });
  }

  /** Max-link: the plan for a scope (books, engines, reasons) — nothing runs yet. */
  planMaxLink(scope: MaxLinkScope, engines?: ReadonlySet<EngineId>): MaxLinkPlan {
    return this.maxLink.plan(scope, engines);
  }

  /** Max-link: runs a plan; its merged suggestions become the current run. */
  runMaxLink(plan: MaxLinkPlan, scopeLabel: string, options?: MaxLinkRunOptions): Promise<boolean> {
    return this.maxLink.run(plan, scopeLabel, options);
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
    if (src.books.length) {
      this.notify("success", `נפתחו ${src.books.length.toLocaleString("he")} ספרים מ־${src.info.label}.`);
      this.chooseRoles(src.books);
    }
    this.screen.value = "workspace";
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
  readonly dialog = signal<"relink" | "help" | "alt-toc" | null>(null);
  /** the guide section (heading id) the help opens at */
  readonly helpSection = signal<string | undefined>(undefined);

  openHelp(section?: string): void {
    this.helpSection.value = section;
    this.dialog.value = "help";
  }
  readonly relink = signal<{ oldKey: string; newKey: string; plan: RelinkPlan; stats: Record<string, number> } | null>(null);

  async planRelinkFor(oldKey: string, newKey: string): Promise<boolean> {
    const diff = await this.runTask("משווה בין המהדורות…", (opts) => this.service.diffBooks(oldKey, newKey, opts));
    if (!diff) return false;
    const oldRef = this.refOf(oldKey);
    const anchored = this.allLinks.value.filter((l) => l.anchor && this.sameBook(l.source.book, oldKey));
    for (const l of anchored) {
      await this.lines.load(oldKey, l.source.line, l.source.line);
      const to = diff.to[l.source.line] ?? -1;
      if (to >= 0) await this.lines.load(newKey, to, to);
    }
    const plan = planRelink({
      links: this.allLinks.value,
      oldBook: oldRef,
      newBook: this.refOf(newKey),
      mapping: { to: Int32Array.from(diff.to), fate: diff.fate },
      oldLine: (i) => this.lines.peek(oldKey, i)?.anchorText,
      newLine: (i) => this.lines.peek(newKey, i)?.anchorText,
      isOld: (ref) => this.sameBook(ref, oldKey),
    });
    this.relink.value = { oldKey, newKey, plan, stats: diff.stats };
    return true;
  }

  /** Applies chosen items of the relink plan as ONE undoable action. */
  applyRelink(items: readonly RelinkItem[]): number {
    const s = this.linkState.value;
    const changes: Change[] = items.filter((i) => i.moved && s.links.has(i.link.id)).map((i) => ({ id: i.link.id, before: s.links.get(i.link.id)!, after: i.moved! }));
    this.apply(`העברת ${linksCount(changes.length)} למהדורה החדשה`, changes);
    return changes.length;
  }

  /* ---------------- import / export ---------------- */

  /** the text layout of each book's imported links file, reused when it is written back (minimal library diff) */
  private readonly fileLayouts = new Map<string, JsonLayout>();

  importLinksFile(path: string, text: string): void {
    const sourceTitle = sourceTitleFromLinksFileName(path);
    if (!sourceTitle) return void this.notify("error", `"${path}": שם קובץ קישורים חייב להסתיים ב־‎_links.json, כי ממנו אוצריא יודעת מהו ספר המקור.`);
    const parsed = parseLinksJson(text);
    const sourceRef = this.resolveTitle(sourceTitle) ?? { key: `unresolved:${sourceTitle}`, title: sourceTitle, origin: "unknown" as const };
    const fileKey = `${sourceTitle}#${this.linkSeq++}`;
    this.fileLayouts.set(sourceTitle, detectLayout(text));
    this.dbLinks.noteImportedFile(sourceTitle);
    const issues = [...parsed.issues];
    const links = parsed.records.map((r, i) => {
      const { link, issues: more } = recordToLink(r, i, sourceRef, (t) => this.resolveTitle(t), `file:${fileKey}:${i}`);
      issues.push(...more);
      return link;
    });
    this.apply(`ייבוא ${sourceTitle}_links.json (${linksCount(links.length)})`, addChanges(links));
    const errors = issues.filter((i) => i.level === "error");
    const details = issues.slice(0, 200).map((i) => `${i.index >= 0 ? `רשומה ${i.index + 1}: ` : ""}${i.message}`);
    if (parsed.generatorRejectsFile)
      this.notify("error", `"${path}": אוצריא הייתה דוחה את הקובץ הזה כולו כמו שהוא (${new Set(errors.map((e) => e.index)).size} רשומות פגומות). הרשומות התקינות נטענו; בייצוא הקובץ ייכתב מחדש תקין.`, details);
    else if (issues.length) this.notify("warning", `"${path}": נטענו ${links.length} קישורים, עם ${issues.length} הערות.`, details);
    else this.notify("success", `נטענו ${links.length.toLocaleString("he")} קישורים מ־"${path}".`);
    if (sourceRef.origin === "unknown") this.notify("info", `ספר המקור "${sourceTitle}" עדיין לא פתוח. פתחו אותו (או את המסד שבו הוא נמצא) כדי לראות את הקישורים על הטקסט.`);
  }

  /** A spreadsheet of links (CSV/TSV): one links file per source book, through the same import. */
  importLinksCsv(path: string, text: string): void {
    const r = parseLinksCsv(text, path);
    // a sheet whose columns are not the library's names: let the user map them instead of failing
    if (!r.files.length && r.problems.some((p) => p.startsWith("חסרה עמודה"))) return this.offerRecords(path, text);
    if (r.problems.length) this.notify(r.files.length ? "warning" : "error", `"${path}": ${r.problems.length} בעיות בגיליון.`, r.problems.slice(0, 100));
    for (const f of r.files) this.importLinksFile(`${f.sourceTitle}_links.json`, f.text);
  }

  resolveTitle(title: string): BookRef | null {
    const hits = this.booksByTitle.value.get(title) ?? this.booksByTitle.value.get(titleFromPath2(title));
    const b = hits?.find((x) => x.origin !== "personal") ?? hits?.[0];
    return b ? this.refOf(b.key) : null;
  }

  /** Loads the lines at both ends of every link, so the rules can be checked on real lines. */
  private async loadLinkLines(label: string): Promise<boolean> {
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

  /** Loads every line the export must check (ends of every link, alt_toc lines) and returns the plan. */
  async prepareExport(): Promise<ExportBundle | null> {
    if (!(await this.loadLinkLines("בודק את הקישורים לפני הייצוא…"))) return null;
    await this.altToc.loadLines();
    return { ...planExport(this.allLinks.value, this.validation(), { layouts: (t) => this.fileLayouts.get(t) }), altToc: this.altToc.plan() };
  }

  /** The links the plan writes, as CSV in Sefaria's layout (reads the headings of their books for the citations). */
  async prepareSefariaCsv(plan: ExportPlan): Promise<SefariaCsvFile[] | null> {
    const dropped = new Set(["export/heading-line", "export/line-out-of-range", "export/line-not-in-db"]);
    const bad = new Set(plan.warned.filter((w) => w.problems.some((p) => dropped.has(p.code))).map((w) => w.link.id));
    const links = plan.written.filter((l) => !bad.has(l.id));
    const headings = new Map<string, BookHeading[]>();
    const ok = await this.runTask("קורא את כותרות הספרים למראי המקום…", async (opts) => {
      const keys = new Set(links.flatMap((l) => [this.bookOf(l.source.book)?.key, l.heRef2 ? undefined : this.bookOf(l.target.book)?.key]).filter((k): k is string => !!k));
      let done = 0;
      for (const key of keys) {
        headings.set(key, await this.service.headings(key, opts));
        opts.onProgress?.(++done, keys.size);
      }
      return true;
    });
    if (!ok) return null;
    return planSefariaCsv(links, (ref) => {
      const b = this.bookOf(ref);
      return b && headings.get(b.key);
    });
  }

  /** `_report.txt` for a plan (and the CSV files, when exporting as CSV). */
  exportReport(plan: ExportBundle, csv?: readonly SefariaCsvFile[]): string {
    return buildExportReport({ date: new Date().toLocaleString("he-IL"), app: APP_VERSION, format: csv ? "sefaria-csv" : "json", links: plan, ...(csv && { csv }), altToc: plan.altToc });
  }

  saveReport(plan: ExportBundle, csv?: readonly SefariaCsvFile[]): void {
    this.saver.save(REPORT_FILE_NAME, this.exportReport(plan, csv), "text/plain;charset=utf-8");
  }

  async runQualityCheck(): Promise<QaReport | null> {
    if (!(await this.loadLinkLines("בודק את איכות הקישורים…"))) return null;
    const report = runQa(this.allLinks.value, this.validation());
    batch(() => {
      this.qa.value = report;
      this.qaRevision.value = this.linkState.value.revision;
    });
    return report;
  }

  saveQaReport(): void {
    if (this.qa.value) this.saver.save(`בדיקת-קישורים-${new Date().toISOString().slice(0, 10)}.csv`, qaCsv(this.qa.value), "text/csv");
  }

  /**
   * Saves the export. One file alone downloads as that file; anything more is one ZIP laid out like
   * the library — links/, alt_toc/ — with `_report.txt` at its root. `csv` replaces the links files
   * with Sefaria-layout CSV files.
   */
  saveExport(plan: ExportPlan | ExportBundle, csv?: readonly SefariaCsvFile[]): void {
    const bundle: ExportBundle = "altToc" in plan ? plan : { ...plan, altToc: { files: [], heldBack: [] } };
    const data = [
      ...(csv ? csv.map((f) => ({ path: f.name, text: f.text, mime: "text/csv;charset=utf-8" })) : plan.files.map((f) => ({ path: `links/${f.name}`, text: f.text, mime: "application/json" }))),
      ...bundle.altToc.files.map((f) => ({ path: `alt_toc/${f.name}`, text: f.text, mime: "application/json" })),
    ];
    if (!data.length) return;
    if (data.length === 1) this.saver.save(data[0]!.path.split("/").at(-1)!, data[0]!.text, data[0]!.mime);
    else this.saver.save(`links-${new Date().toISOString().slice(0, 10)}.zip`, zipBundle([...data, { path: REPORT_FILE_NAME, text: this.exportReport(bundle, csv) }]), "application/zip");
    this.savedRevision.value = this.linkState.value.revision;
    const alt = bundle.altToc.files.length;
    this.notify("success", `יוצאו ${(csv ? csv.reduce((n, f) => n + f.rows, 0) : plan.written.length).toLocaleString("he")} קישורים ב־${csv ? csv.length : plan.files.length} קבצים${alt ? `, ומבני כותרות ל־${alt} ספרים` : ""}.`);
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
      existing: (l) => this.dbLinks.matchDb(l),
    };
  }

  /* ---------------- projects, autosave, recovery ---------------- */

  projectText(): string {
    const titleOf = (k: string | null) => (k ? this.refOf(k).title : null);
    return serializeProject(
      {
        sources: this.sources.value.map((s) => ({ label: s.info.label, kind: s.info.kind, books: s.books.length })),
        links: this.allLinks.value,
        rejectedSuggestions: [...this.rejected.value],
        view: { source: titleOf(this.view.source.value), target: titleOf(this.view.target.value) },
        altToc: this.altToc.list.value,
        dbMappings: [...this.dbMappings.value.values()],
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
    batch(() => {
      this.linkState.value = commit(this.linkState.value, `פתיחת פרויקט (${linksCount(p.links.length)})`, changes.filter((c) => c.before !== c.after), Date.now(), altChanges);
      this.rejected.value = new Set(p.rejectedSuggestions);
      if (p.dbMappings?.length) this.dbMappings.value = new Map([...this.dbMappings.value, ...p.dbMappings.map((m) => [m.fingerprint, m] as const)]);
      this.savedRevision.value = this.linkState.value.revision;
      const show = (title: string | null) => (title ? this.booksByTitle.value.get(title)?.[0]?.key ?? null : null);
      this.view.source.value = show(p.view.source) ?? this.view.source.value;
      this.view.target.value = show(p.view.target) ?? this.view.target.value;
      this.screen.value = "workspace";
    });
    const open = new Set(this.sources.value.map((s) => s.info.label));
    const missing = p.sources.filter((s) => !open.has(s.label)).map((s) => s.label);
    this.notify("success", `נפתח פרויקט מ־${p.savedAt ? new Date(p.savedAt).toLocaleString("he") : "תאריך לא ידוע"}: ${p.links.length.toLocaleString("he")} קישורים.`);
    if (missing.length) this.notify("info", `כדי לראות את הקישורים על הטקסט, פתחו שוב את המקורות: ${missing.join(", ")}. הקישורים יתחברו לספרים לפי השם.`);
    if (p.skipped) this.notify("warning", `${p.skipped} רשומות פגומות בפרויקט דולגו.`);
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

  /* ---------------- links in someone else's layout (JSON, JSON Lines, CSV with other columns) ---------------- */

  /** files waiting for the field-mapping dialog, first one shown */
  readonly pendingRecords = signal<{ path: string; table: RecordsTable; mapping: RecordsMapping }[]>([]);

  offerRecords(path: string, text: string): void {
    const table = parseRecords(text, path);
    if (!table) return void this.notify("error", `"${path}": לא נמצאו בקובץ רשומות קישורים (מערך של אובייקטים, JSON Lines או טבלה עם שורת כותרות).`);
    this.pendingRecords.value = [...this.pendingRecords.value, { path, table, mapping: guessRecordsMapping(table) }];
  }

  /** Imports the first waiting file with the user's mapping, through the ordinary links-file import. */
  importRecords(mapping: RecordsMapping): void {
    const [first, ...rest] = this.pendingRecords.value;
    if (!first) return;
    const r = recordsToLinksFiles(first.table, mapping, first.path);
    this.pendingRecords.value = rest;
    if (r.problems.length) this.notify(r.files.length ? "warning" : "error", `"${first.path}": ${r.problems.length} רשומות לא יובאו.`, r.problems);
    for (const f of r.files) this.importLinksFile(`${f.sourceTitle}_links.json`, f.text);
  }

  skipRecords(): void {
    this.pendingRecords.value = this.pendingRecords.value.slice(1);
  }

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

  async runTask<T>(label: string, run: (opts: { signal?: AbortSignal; onProgress?: (d: number, t: number) => void }) => Promise<T>): Promise<T | null> {
    const ac = new AbortController();
    const logged = logTask(this.log, label);
    this.task.value = { label, done: 0, total: 0, cancel: () => ac.abort() };
    try {
      const result = await run({ signal: ac.signal, onProgress: (done, total) => (this.task.value = { label, done, total, cancel: () => ac.abort() }) });
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


/**
 * "These two lines are already linked": both ends, in either direction and of any type — the
 * "same-lines" level of the ONE equality rule (core/links/equality.ts), shared with the worker
 * through linking/merge.ts. Kept under this name for existing callers.
 */
export { linePairKey };

/** A suggestion's identity across sessions: engine, book titles, lines and anchor — never session keys. */
export function rejectionKey(s: Suggestion): string {
  const end = (e: LinkSide) => `${e.book.title}#${e.line}${e.end !== undefined ? `-${e.end}` : ""}`;
  return `${s.engine}|${end(s.source)}${s.anchor ? `@${s.anchor.rawStart}` : ""}>${end(s.target)}`;
}

/**
 * Every key a rejection of this suggestion is stored and recognised under. A merged (max-link)
 * suggestion also has the key of each raw suggestion it was made of — so a rejection made in a
 * single-engine run still holds — and one without engine or direction, which survives a re-run whose
 * representative record comes from another engine. (Its anchor counts only where one engine gave
 * several links between the same two lines — footnote markers — and the merge kept them apart.)
 */
export function rejectionKeys(s: Suggestion): string[] {
  const members = (s as { members?: readonly { suggestion: Suggestion }[] }).members;
  if (!members?.length) return [rejectionKey(s)];
  const end = (e: LinkSide) => `${e.book.title}#${e.line}${e.end !== undefined ? `-${e.end}` : ""}`;
  const pair = (x: Suggestion) => [end(x.source), end(x.target)].sort().join("<>");
  const own = pair(s);
  const exact = members.filter((m) => pair(m.suggestion) === own).map((m) => rejectionKey(m.suggestion));
  const split = s.id.includes("@") && s.anchor ? `@${end(s.source)}:${s.anchor.rawStart}` : "";
  return [...new Set([rejectionKey(s), ...exact])].concat(`*|${own}${split}`);
}

declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

export const TYPE_CHOICES = AUTHORABLE_TYPES.map((t) => t.toLowerCase());
export const isKnownType = (raw: string): boolean => parseConnectionType(raw).known;
