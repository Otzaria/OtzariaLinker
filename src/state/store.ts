import { batch, computed, effect, signal } from "@preact/signals";
import { parseProject, serializeProject } from "../projects/project-format";
import type { SourceBook } from "../core/books";
import { AUTHORABLE_TYPES, parseConnectionType } from "../core/links/connection-type";
import type { BookRef, Link, LinkSide, RawAnchor } from "../core/links/model";
import { path2ForTitle, sourceTitleFromLinksFileName, titleFromPath2 } from "../core/links/titles";
import { validateLink, type LineFacts, type Problem, type ValidationContext } from "../core/links/validate";
import { stripTags } from "../core/text/html";
import { recordToLink } from "../formats/links-json/convert";
import { storedKey } from "../core/links/stored-form";
import { CONFIDENCE_ORDER, type Confidence, type EngineId, type EngineResult, type Suggestion } from "../linking/automatic";
import { planExport, zipExport, type ExportPlan } from "../formats/links-json/export";
import { parseLinksJson } from "../formats/links-json/parse";
import { addChanges, commit, deleteChange, editChange, emptyLinkState, redo, restoreChange, undo, type Change, type LinkState } from "./history";
import { LineStore } from "./lines";
import { loadPreferences, type Preferences } from "./preferences";
import type { BooksService, InputFile, KeyValueStore, OpenedSource, Saver } from "./services";

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
export type SideTab = "builder" | "links" | "suggestions" | "books";

/** One run of an automatic engine and the user's decisions on it. */
export interface SuggestionRun {
  engine: EngineId;
  source: BookRef;
  target: BookRef;
  result: EngineResult;
  at: number;
}
/** pending → the user has not decided; approved → a link exists for it; exists → the project already has that link */
export type SuggestionState = "pending" | "approved" | "rejected" | "exists";

export class AppStore {
  readonly prefs: Preferences;
  readonly lines: LineStore;

  readonly screen = signal<Screen>("home");
  readonly sources = signal<OpenedSource[]>([]);
  readonly linkState = signal<LinkState>(emptyLinkState());
  readonly view = { source: signal<string | null>(null), target: signal<string | null>(null) };
  readonly pick = { source: signal<Pick | null>(null), target: signal<Pick | null>(null) };
  /** the reader that receives the next click in "click" create mode and keyboard focus */
  readonly activeSide = signal<Side>("source");
  readonly draftType = signal<string>("commentary");
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
  /** rejected suggestion ids — kept across re-runs, since suggestion ids are deterministic */
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
    return d ? validateLink(d, this.validation()) : [];
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
  }

  /* ---------------- sources ---------------- */

  async openFiles(files: InputFile[]): Promise<void> {
    if (!files.length) return;
    const res = await this.runTask(`פותח ${files.length === 1 ? files[0]!.path : `${files.length} קבצים`}…`, (opts) => this.service.open(files, opts));
    if (!res) return;
    batch(() => {
      this.sources.value = [...this.sources.value, ...res.sources];
      for (const s of res.sources) for (const w of s.info.warnings) this.notify("warning", `${s.info.label}: ${w.message}`);
    });
    for (const d of res.documents) if (d.kind === "links-json") this.importLinksFile(d.path, d.text);
    for (const d of res.documents) if (d.kind === "project") this.openProject(d.path, d.text);
    if (res.skipped.length)
      this.notify("warning", `${res.skipped.length} קבצים לא נפתחו.`, res.skipped.map((s) => `${s.path}: ${s.reason}`));
    const opened = res.sources.flatMap((s) => s.books);
    if (opened.length) {
      this.notify("success", `נפתחו ${opened.length.toLocaleString("he")} ספרים מ־${res.sources.map((s) => s.info.label).join(", ")}.`);
      if (!this.view.source.value) this.view.source.value = opened[0]!.key;
      this.screen.value = "workspace";
    } else if (res.documents.length) this.screen.value = "workspace";
  }

  async closeSource(id: string): Promise<void> {
    const s = this.sources.value.find((x) => x.info.id === id);
    if (!s) return;
    await this.service.close(id);
    batch(() => {
      this.sources.value = this.sources.value.filter((x) => x.info.id !== id);
      for (const side of ["source", "target"] as const) {
        if (this.view[side].value?.startsWith(`${id}:`)) this.view[side].value = null;
        if (this.pick[side].value?.bookKey.startsWith(`${id}:`)) this.pick[side].value = null;
      }
    });
    this.lines.forgetSource(id);
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
    if (side === "target") this.draftHeRef.value = this.editing.value ? this.draftHeRef.value : null;
    this.activeSide.value = side;
  }

  pickAnchor(side: Side, bookKey: string, line: number, anchor: Pick["anchor"]): void {
    this.pick[side].value = { bookKey, line, ...(anchor && { anchor }) };
    this.activeSide.value = side;
  }

  clearPicks(): void {
    batch(() => {
      this.pick.source.value = null;
      this.pick.target.value = null;
      this.editing.value = null;
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
      this.apply("עריכת קישור", [{ id: before.id, before, after }]);
      this.clearPicks();
      return after;
    }
    const link: Link = { ...d, id: this.newLinkId(), status: "new", provenance: "user" };
    this.apply("יצירת קישור", addChanges([link]));
    batch(() => {
      this.pick.target.value = null;
      this.draftHeRef.value = null;
      this.draftRef2.value = "";
      // keep the source pick only when it was a range/anchor the user may link again; else advance to the next line
      const s = this.pick.source.value;
      if (s && !s.anchor && s.end === undefined) this.pick.source.value = { bookKey: s.bookKey, line: s.line + 1 };
    });
    return link;
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
    this.apply(changes.length === 1 ? "מחיקת קישור" : `מחיקת ${changes.length} קישורים`, changes);
    if (this.editing.value && ids.includes(this.editing.value)) this.clearPicks();
  }

  restoreLinks(ids: readonly string[]): void {
    const s = this.linkState.value;
    this.apply("שחזור קישור", ids.map((id) => restoreChange(s, id)).filter((c): c is Change => !!c));
  }

  setType(ids: readonly string[], declaredType: string): void {
    const s = this.linkState.value;
    this.apply("שינוי סוג קשר", ids.map((id) => editChange(s, id, { declaredType })).filter((c): c is Change => !!c));
  }

  undo(): void {
    const label = this.linkState.value.undo.at(-1)?.label;
    this.linkState.value = undo(this.linkState.value);
    if (label) this.notify("info", `בוטל: ${label}`);
  }

  redo(): void {
    const label = this.linkState.value.redo.at(-1)?.label;
    this.linkState.value = redo(this.linkState.value);
    if (label) this.notify("info", `בוצע שוב: ${label}`);
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
    batch(() => {
      this.run.value = { engine, source, target, result, at: Date.now() };
      this.currentSuggestion.value = result.suggestions[0]?.id ?? null;
      this.sideTab.value = "suggestions";
    });
    const c = this.suggestionCounts.value;
    this.notify("success", `נמצאו ${result.suggestions.length.toLocaleString("he")} הצעות: ${c.certain} ודאיות, ${c.high} גבוהות, ${c.possible + c.ambiguous} לבדיקה.`);
    return true;
  }

  readonly suggestionState = computed(() => {
    const run = this.run.value;
    const m = new Map<string, SuggestionState>();
    if (!run) return m;
    const links = this.linkState.value.links;
    const rejected = this.rejected.value;
    const existing = new Set<string>();
    for (const l of links.values()) if (l.status !== "deleted" && !l.id.startsWith("auto:")) existing.add(storedKey(l));
    for (const s of run.result.suggestions) {
      const own = links.get(`auto:${s.id}`);
      m.set(s.id, own && own.status !== "deleted" ? "approved" : rejected.has(s.id) ? "rejected" : existing.has(storedKey(this.suggestionLink(s))) ? "exists" : "pending");
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
      if ([...ids2].some((id) => this.rejected.value.has(id))) this.rejected.value = new Set([...this.rejected.value].filter((id) => !ids2.has(id)));
    });
    return links.length;
  }

  rejectSuggestions(ids: readonly string[]): void {
    const approved = ids.map((id) => `auto:${id}`).filter((id) => this.linkState.value.links.has(id));
    batch(() => {
      if (approved.length) this.apply("ביטול אישור", approved.map((id) => ({ id, before: this.linkState.value.links.get(id)! })));
      this.rejected.value = new Set([...this.rejected.value, ...ids]);
    });
  }

  resetSuggestions(ids: readonly string[]): void {
    const drop = new Set(ids);
    this.rejected.value = new Set([...this.rejected.value].filter((id) => !drop.has(id)));
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

  /* ---------------- import / export ---------------- */

  importLinksFile(path: string, text: string): void {
    const sourceTitle = sourceTitleFromLinksFileName(path);
    if (!sourceTitle) return void this.notify("error", `"${path}": שם קובץ קישורים חייב להסתיים ב־‎_links.json, כי ממנו אוצריא יודעת מהו ספר המקור.`);
    const parsed = parseLinksJson(text);
    const sourceRef = this.resolveTitle(sourceTitle) ?? { key: `unresolved:${sourceTitle}`, title: sourceTitle, origin: "unknown" as const };
    const fileKey = `${sourceTitle}#${this.linkSeq++}`;
    const issues = [...parsed.issues];
    const links = parsed.records.map((r, i) => {
      const { link, issues: more } = recordToLink(r, i, sourceRef, (t) => this.resolveTitle(t), `file:${fileKey}:${i}`);
      issues.push(...more);
      return link;
    });
    this.apply(`ייבוא ${sourceTitle}_links.json (${links.length} קישורים)`, addChanges(links));
    const errors = issues.filter((i) => i.level === "error");
    const details = issues.slice(0, 200).map((i) => `${i.index >= 0 ? `רשומה ${i.index + 1}: ` : ""}${i.message}`);
    if (parsed.generatorRejectsFile)
      this.notify("error", `"${path}": אוצריא הייתה דוחה את הקובץ הזה כולו כמו שהוא (${errors.length} רשומות פגומות). הרשומות התקינות נטענו; בייצוא הקובץ ייכתב מחדש תקין.`, details);
    else if (issues.length) this.notify("warning", `"${path}": נטענו ${links.length} קישורים, עם ${issues.length} הערות.`, details);
    else this.notify("success", `נטענו ${links.length.toLocaleString("he")} קישורים מ־"${path}".`);
    if (sourceRef.origin === "unknown") this.notify("info", `ספר המקור "${sourceTitle}" עדיין לא פתוח. פתחו אותו (או את המסד שבו הוא נמצא) כדי לראות את הקישורים על הטקסט.`);
  }

  resolveTitle(title: string): BookRef | null {
    const hits = this.booksByTitle.value.get(title) ?? this.booksByTitle.value.get(titleFromPath2(title));
    const b = hits?.find((x) => x.origin !== "personal") ?? hits?.[0];
    return b ? this.refOf(b.key) : null;
  }

  /** Loads every line the export must check (ends of every link) and returns the plan. */
  async prepareExport(): Promise<ExportPlan | null> {
    const links = this.allLinks.value.filter((l) => l.status !== "deleted");
    const need = new Map<string, number[]>();
    for (const l of links)
      for (const side of [l.source, l.target]) {
        const b = this.bookOf(side.book);
        if (!b) continue;
        need.set(b.key, [...(need.get(b.key) ?? []), side.line, side.end ?? side.line]);
      }
    const ok = await this.runTask("בודק את הקישורים לפני הייצוא…", async (opts) => {
      let done = 0;
      const total = need.size;
      for (const [key, idx] of need) {
        opts.signal?.throwIfAborted();
        const chunks = [...new Set(idx.map((i) => Math.floor(i / 200)))];
        for (const c of chunks) await this.lines.load(key, c * 200, c * 200);
        opts.onProgress?.(++done, total);
      }
      return true;
    });
    if (!ok) return null;
    return planExport(this.allLinks.value, this.validation());
  }

  saveExport(plan: ExportPlan): void {
    if (plan.files.length === 1) this.saver.save(plan.files[0]!.name, plan.files[0]!.text, "application/json");
    else this.saver.save(`links-${new Date().toISOString().slice(0, 10)}.zip`, zipExport(plan), "application/zip");
    this.savedRevision.value = this.linkState.value.revision;
    this.notify("success", `יוצאו ${plan.written.length.toLocaleString("he")} קישורים ב־${plan.files.length} קבצים.`);
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
        return l ? { exists: l.existsInDb, heading: l.heading, anchorLength: l.anchorText.length } : undefined;
      },
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
      p = parseProject(text, (b) => this.resolveTitle(b.title) ?? { key: `unresolved:${b.title}`, ...b });
    } catch (err) {
      return void this.notify("error", `"${path}": ${(err as Error).message}`);
    }
    const old = this.linkState.value.links;
    const changes: Change[] = [...old.values()].map((l) => ({ id: l.id, before: l }));
    for (const l of p.links) changes.push({ id: l.id, ...(old.get(l.id) && { before: old.get(l.id)! }), after: l });
    batch(() => {
      this.apply(`פתיחת פרויקט (${p.links.length.toLocaleString("he")} קישורים)`, changes.filter((c) => c.before !== c.after));
      this.rejected.value = new Set(p.rejectedSuggestions);
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
        const empty = this.linkState.peek().links.size === 0;
        (empty ? kv.delete(KEY) : kv.set(KEY, this.projectText())).catch(() => {
          /* storage blocked or full — autosave is best effort */
        });
      }, delayMs);
      void rev;
    });
    void kv.get(KEY).then(
      (text) => {
        if (!text || this.linkState.peek().links.size) return;
        let n = 0;
        try {
          n = (JSON.parse(text) as { links?: unknown[] }).links?.length ?? 0;
        } catch {
          return;
        }
        if (n) this.notify("info", `נמצאה עבודה שלא נשמרה מהפעם הקודמת (${n.toLocaleString("he")} קישורים).`, undefined, { label: "שחזור", run: () => this.openProject("שמירה אוטומטית", text) });
      },
      () => {},
    );
    return () => (clearTimeout(timer), stop());
  }

  /* ---------------- notices and tasks ---------------- */

  notify(kind: NoticeKind, text: string, details?: string[], action?: Notice["action"]): void {
    const n: Notice = { id: ++this.noticeSeq, kind, text, ...(details && { details }), ...(action && { action }) };
    this.notices.value = [...this.notices.value, n].slice(-6);
  }

  dismiss(id: number): void {
    this.notices.value = this.notices.value.filter((n) => n.id !== id);
  }

  async runTask<T>(label: string, run: (opts: { signal?: AbortSignal; onProgress?: (d: number, t: number) => void }) => Promise<T>): Promise<T | null> {
    const ac = new AbortController();
    this.task.value = { label, done: 0, total: 0, cancel: () => ac.abort() };
    try {
      return await run({ signal: ac.signal, onProgress: (done, total) => (this.task.value = { label, done, total, cancel: () => ac.abort() }) });
    } catch (err) {
      const e = err as { code?: string; message?: string; name?: string };
      if (e.code === "cancelled" || e.name === "AbortError") this.notify("info", "הפעולה בוטלה. שום דבר לא השתנה.");
      else this.notify("error", e.message ?? String(err));
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
