import { computed, signal, type ReadonlySignal, type Signal } from "@preact/signals";
import type { SourceBook } from "../core/books";
import type { ConnectionType } from "../core/links/connection-type";
import { dbLinkOrigin, type DbLinkDirection, type DbLinkQuery, type DbLinkSummary, type DbLinksUnavailable } from "../core/links/db-links";
import { linkMatchIndex, matchLink, storedLinkIdentity, type LinkMatch, type LinkMatchIndex } from "../core/links/equality";
import { adoptDbLink } from "../core/links/from-db";
import type { BookRef, Link } from "../core/links/model";
import type { LinksFileState, Problem } from "../core/links/validate";
import { sourceTitleFromLinksFileName } from "../core/links/titles";
import { addChanges, commit, deleteChange, linksCount, type Change, type LinkState } from "./history";
import { CHUNK, type LineStore } from "./lines";
import type { BooksService, CallOptions, InputFile } from "./services";
import type { ExchangeState } from "./exchange";
import type { NoticeKind, Pick, Side } from "./store";

/*
 * The links an opened database already has, as a first-class, READ-ONLY part of the links tab
 * (stage 10): a book's database links counted by type and by the other book, filtered and paged
 * from the worker; the links of the picked line, project and database side by side; and
 * "העתקה לפרויקט", which turns chosen database links into project links (provenance "db-copy")
 * through core/links/from-db.ts as ONE undoable action. The database itself is never written.
 * Kept out of store.ts on purpose (like AltTocState): the store only creates it and asks it two
 * questions during validation.
 */
export interface DbLinksHost {
  readonly linkState: Signal<LinkState>;
  readonly books: ReadonlySignal<Map<string, SourceBook>>;
  readonly lines: LineStore;
  readonly view: Record<Side, Signal<string | null>>;
  readonly pick: Record<Side, Signal<Pick | null>>;
  bookOf(ref: BookRef): SourceBook | undefined;
  /** a library links file found in the picked files is imported like any other (state/exchange.ts) */
  readonly exchange: { importLinksFile: ExchangeState["importLinksFile"] };
  loadSefariaTitles(path: string, text: string): boolean;
  isSefariaOwned(book: { readonly title: string }): boolean;
  notify(kind: NoticeKind, text: string, details?: string[]): void;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>): Promise<T | null>;
}

export type LinksTabView = "project" | "db";

/** What the list is narrowed to (the book is the one shown in the chosen reader). */
export interface DbLinkFilter {
  dir?: DbLinkDirection;
  types?: readonly ConnectionType[];
  otherBookKey?: string;
  /** only the line (or range) picked in the chosen reader */
  pickedLine?: boolean;
}

export const DB_PAGE = 100;

export class DbLinksState {
  /** which list the links tab shows */
  readonly tab = signal<LinksTabView>("project");
  /** whose book is listed: the source reader's or the target reader's */
  readonly side = signal<Side>("source");
  readonly filter = signal<DbLinkFilter>({});
  readonly summary = signal<DbLinkSummary | DbLinksUnavailable | null>(null);
  readonly list = signal<{ query: string; total: number; links: Link[]; loading: boolean } | null>(null);
  /** database link ids the user ticked for copying */
  readonly selected = signal<ReadonlySet<string>>(new Set());
  /**
   * titles the user confirmed in the export dialog: the library has no links file for the book, or the
   * project's copy of it is the current one — the export may write the book's file without loading it
   */
  readonly newFileOk = signal<ReadonlySet<string>>(new Set());

  readonly bookKey = computed(() => this.host.view[this.side.value].value);

  /** The project's links, indexed by the shared equality rule — "already in the project" badges. */
  readonly projectIndex = computed<LinkMatchIndex>(() => linkMatchIndex([...this.host.linkState.value.links.values()].filter((l) => l.status !== "deleted")));

  private seq = 0;
  private copySeq = 0;

  constructor(
    private readonly host: DbLinksHost,
    private readonly service: BooksService,
  ) {}

  get available(): boolean {
    return !!this.service.dbLinkSummary && !!this.service.dbLinksPage;
  }

  /** Counts for the listed book (a big base book takes a few seconds: progress and cancel in the top bar). */
  async loadSummary(bookKey: string): Promise<void> {
    if (!this.service.dbLinkSummary) return void (this.summary.value = { bookKey, reason: "הכלי שפתוח כאן אינו יודע לקרוא קישורים ממסד." });
    const title = this.host.books.value.get(bookKey)?.title ?? bookKey;
    const got = await this.host.runTask(`קורא את הקישורים של "${title}" מהמסד…`, (opts) => this.service.dbLinkSummary!(bookKey, opts));
    if (this.bookKey.peek() !== bookKey) return;
    this.summary.value = got ?? { bookKey, reason: "קריאת הקישורים מהמסד לא הושלמה.", retry: true };
  }

  /** The query the panel shows now, or null when there is no book or the line filter has no line. */
  query(offset = 0): (DbLinkQuery & { bookKey: string }) | null {
    const bookKey = this.bookKey.value;
    if (!bookKey) return null;
    const f = this.filter.value;
    const pick = this.host.pick[this.side.value].value;
    if (f.pickedLine && (!pick || pick.bookKey !== bookKey)) return null;
    return {
      bookKey,
      offset,
      limit: DB_PAGE,
      ...(f.dir && { dir: f.dir }),
      ...(f.types?.length && { types: f.types }),
      ...(f.otherBookKey && { otherBookKey: f.otherBookKey }),
      ...(f.pickedLine && pick && { lines: { from: pick.line, to: pick.end ?? pick.line } }),
    };
  }

  /** Loads the first page of the current query, or (more) appends the next one. */
  async loadPage(more = false): Promise<void> {
    const q = this.query(more ? (this.list.peek()?.links.length ?? 0) : 0);
    if (!q || !this.service.dbLinksPage) return void (this.list.value = null);
    const key = JSON.stringify({ ...q, offset: 0 });
    const prev = this.list.peek();
    const keep = more && prev?.query === key ? prev.links : [];
    const seq = ++this.seq;
    this.list.value = { query: key, total: prev?.query === key ? prev.total : 0, links: keep, loading: true };
    try {
      const { bookKey, ...query } = q;
      const page = await this.service.dbLinksPage(bookKey, query);
      if (seq === this.seq) this.list.value = { query: key, total: page.total, links: [...keep, ...page.links], loading: false };
    } catch (err) {
      if (seq === this.seq) this.list.value = { query: key, total: 0, links: keep, loading: false };
      this.host.notify("error", (err as Error).message ?? String(err));
    }
  }

  setFilter(patch: Partial<DbLinkFilter>): void {
    const next = { ...this.filter.value, ...patch };
    for (const k of Object.keys(next) as (keyof DbLinkFilter)[]) if (next[k] === undefined || next[k] === false) delete next[k];
    this.filter.value = next;
    this.selected.value = new Set();
  }

  toggleSelected(id: string): void {
    const next = new Set(this.selected.value);
    if (!next.delete(id)) next.add(id);
    this.selected.value = next;
  }

  /** How a database link stands against the project, by the shared rule. */
  inProject(l: Link): LinkMatch | null {
    return matchLink(l, this.projectIndex.value);
  }

  /**
   * Whether "copy to the project" can make anything of a database link, or why not (Hebrew): a LINKER
   * citation or a Sefaria↔Sefaria link cannot be written in a links file, and one already in the project
   * is not copied again. One rule for the row's button and for "select the shown" (product audit F11).
   */
  whyNotCopyable(l: Link): string | null {
    const origin = dbLinkOrigin(l);
    if (origin === "linker" || origin === "sefaria") return "אי אפשר לכתוב קישור כזה בקובץ קישורים";
    if (this.inProject(l) === "same-link") return "כבר בפרויקט";
    return null;
  }

  /** The picked line's links: the project's and the database's, kept apart (the per-line view). */
  lineLinks(side: Side): { line: number; end: number; bookKey: string; project: Link[]; db: Link[] | undefined } | null {
    const pick = this.host.pick[side].value;
    if (!pick) return null;
    const end = pick.end ?? pick.line;
    const touches = (l: Link, key: string) =>
      [l.source, l.target].some((e) => {
        const b = this.host.bookOf(e.book);
        return b?.key === key && e.line <= end && (e.end ?? e.line) >= pick.line;
      });
    const project = [...this.host.linkState.value.links.values()].filter((l) => touches(l, pick.bookKey));
    // the chunk cache holds links that start, end or are covered (link_coverage) at these lines
    this.host.lines.tick.value;
    const chunk = this.host.lines.existingAt(pick.bookKey, pick.line);
    const db = chunk?.filter((l) => touches(l, pick.bookKey));
    return { line: pick.line, end, bookKey: pick.bookKey, project, db };
  }

  /**
   * "העתקה לפרויקט": each chosen database link becomes a project link (provenance "db-copy") in ONE
   * undoable action. Links that cannot be written to a file, and links the project already has, are
   * skipped with the reason. Returns how many were copied.
   */
  async adopt(links: readonly Link[]): Promise<number> {
    const db = links.filter((l) => l.provenance === "db");
    if (!db.length) return 0;
    const ok = await this.host.runTask(`מעתיק ${linksCount(db.length)} מהמסד…`, async (opts) => {
      let done = 0;
      for (const l of db) {
        opts.signal?.throwIfAborted();
        for (const e of [l.source, l.target]) {
          const b = this.host.bookOf(e.book);
          if (b) await this.host.lines.load(b.key, e.line, e.line);
        }
        opts.onProgress?.(++done, db.length);
      }
      return true;
    });
    if (!ok) return 0;

    const ctx = {
      line: (book: BookRef, index: number) => {
        const b = this.host.bookOf(book);
        const l = b && this.host.lines.peek(b.key, index);
        return l ? { anchorText: l.anchorText, heRef: l.heRef } : undefined;
      },
      hasLinksFile: (title: string) => this.linksFile(title) !== "missing",
      sefariaOwned: (book: BookRef) => this.host.isSefariaOwned(book),
    };
    const index = this.projectIndex.peek();
    const made: Link[] = [];
    const blocked: string[] = [];
    let already = 0;
    const notes = new Map<string, { problem: Problem; n: number }>();
    for (const l of db) {
      if (matchLink(l, index) === "same-link") {
        already++;
        continue;
      }
      const r = adoptDbLink(l, `c:${Date.now().toString(36)}:${(++this.copySeq).toString(36)}`, ctx);
      const where = `${l.source.book.title} ${l.source.line + 1} ← ${l.target.book.title} ${l.target.line + 1}`;
      if (!r.link) {
        blocked.push(`${where}: ${r.problems.find((p) => p.severity === "error")?.message ?? ""}`);
        continue;
      }
      made.push(r.link);
      for (const p of r.problems) {
        if (p.severity === "info" && p.code === "adopt/heref") continue; // said once below, not per link
        const n = notes.get(p.code);
        notes.set(p.code, { problem: p, n: (n?.n ?? 0) + 1 });
      }
    }
    if (made.length) {
      this.host.linkState.value = commit(this.host.linkState.value, made.length === 1 ? "העתקת קישור מהמסד" : `העתקת ${linksCount(made.length)} מהמסד`, addChanges(made));
      this.selected.value = new Set();
      const details = [...notes.values()].map(({ problem, n }) => `${n > 1 ? `(${n}) ` : ""}${problem.message}`);
      const missing = [...new Set(made.map((m) => m.source.book.title))].filter((t) => this.linksFile(t) === "missing");
      this.host.notify(
        missing.length ? "warning" : "success",
        `${made.length === 1 ? "הקישור הועתק" : `הועתקו ${linksCount(made.length)}`} לפרויקט. שם המקום (heRef_2) נלקח מהמסד — בדקו אותו.${missing.length ? ` לפני ייצוא טענו את קובץ הקישורים של ${missing.map((t) => `"${t}"`).join(", ")} מהספרייה: ייצוא בלעדיו היה מחליף את הקובץ שבספרייה.` : ""}`,
        details,
      );
    }
    if (already) this.host.notify("info", already === 1 ? "הקישור כבר בפרויקט (אותו קישור אחרי ההמרה של אוצריא), ולכן לא הועתק שוב." : `${linksCount(already)} כבר בפרויקט (אותו קישור אחרי ההמרה של אוצריא), ולכן לא הועתקו שוב.`);
    if (blocked.length)
      this.host.notify("warning", blocked.length === 1 ? "הקישור לא הועתק: אי אפשר לכתוב אותו בקובץ קישורים." : `${linksCount(blocked.length)} לא הועתקו: אי אפשר לכתוב אותם בקובץ קישורים.`, blocked.slice(0, 100));
    return made.length;
  }

  /**
   * Whether the project holds a book's links file (the file rules of core/links/validate.ts), from
   * the undoable state only: a file counts as loaded when an import that PARSED put it in
   * LinkState.files in this session; undoing the import forgets it (security review A2). A file
   * restored from a saved project — or "file" links with no record of their file — is only a
   * snapshot: "unverified" until it is loaded again or confirmed (A3).
   */
  linksFile(title: string): LinksFileState {
    const s = this.host.linkState.value;
    const f = s.files.get(title);
    if (f?.verified) return "imported";
    if (this.newFileOk.value.has(title)) return "confirmed-new";
    if (f) return "unverified";
    for (const l of s.links.values()) if (l.provenance === "file" && l.source.book.title === title) return "unverified";
    return "missing";
  }

  /** The user says the library has no links file for this book: copied links may start a new one. */
  confirmNewFile(title: string, ok = true): void {
    const next = new Set(this.newFileOk.value);
    if (ok) next.add(title);
    else next.delete(title);
    this.newFileOk.value = next;
  }

  /**
   * Loads the links files of the given books from what the user picked: the files themselves, or a
   * whole library folder (only `<title>_links.json` files are read). Returns the titles found.
   */
  async loadLinksFiles(files: readonly InputFile[], titles: readonly string[]): Promise<string[]> {
    const want = new Set(titles);
    const found: string[] = [];
    // a library checkout carries the list of Sefaria titles its sync and gate use: it wins over the embedded one (B6)
    const list = files.find((f) => f.path.replace(/\\/g, "/").endsWith(".github/data/sefaria_he_titles.txt"));
    if (list) this.host.loadSefariaTitles(list.path, await list.blob.text());
    for (const f of files) {
      const title = sourceTitleFromLinksFileName(f.path.split(/[\\/]/).at(-1) ?? f.path);
      if (!title || !want.has(title) || found.includes(title)) continue;
      this.host.exchange.importLinksFile(f.path, await f.blob.text());
      found.push(title);
    }
    if (found.length) this.dropCopiesFoundInFiles();
    const missing = titles.filter((t) => !found.includes(t));
    if (missing.length)
      this.host.notify("warning", `לא נמצא קובץ קישורים ל־${missing.map((t) => `"${t}"`).join(", ")} במה שנבחר. בספרייה הקבצים נמצאים בתיקיות links (למשל MoreBooks/links). אם באמת אין לספר קובץ, אשרו זאת בחלון הייצוא.`);
    return found;
  }

  /**
   * Copies of database links that a just-loaded library file turns out to hold already: the file's
   * record is the original (exact heRef_2, type and file), the copy only a reconstruction, so the
   * copy is removed — one undoable action, said in a notice.
   */
  private dropCopiesFoundInFiles(): void {
    const s = this.host.linkState.value;
    const inFiles = new Set<string>();
    for (const l of s.links.values()) if (l.provenance === "file" && l.status !== "deleted") inFiles.add(storedLinkIdentity(l) ?? "");
    const changes = [...s.links.values()]
      .filter((l) => l.provenance === "db-copy" && l.status === "new" && inFiles.has(storedLinkIdentity(l) ?? "-"))
      .map((l) => deleteChange(s, l.id))
      .filter((c): c is Change => !!c);
    if (!changes.length) return;
    this.host.linkState.value = commit(s, `הסרת ${linksCount(changes.length)} שהועתקו מהמסד ונמצאו בקובץ`, changes);
    this.host.notify("info", `${linksCount(changes.length)} שהועתקו מהמסד נמצאו בקובץ שנטען, ולכן העותקים הוסרו והרשומות המקוריות שבקובץ נשארו (Ctrl+Z מחזיר).`);
  }

  /**
   * How a project link matches the database links already loaded around it (validation: "already in
   * the database"), by the shared rule. A database link on both of the link's lines is in the chunk
   * of either line (atLines reads both directions and coverage); both ends are tried, because one of
   * them may be a text book (titles match, keys do not). One index per chunk, kept while the chunk
   * is cached — never an index of everything loaded.
   */
  matchDb(l: Link): LinkMatch | null {
    this.host.lines.tick.value; // re-run when chunks arrive
    let best: LinkMatch | null = null;
    for (const end of [l.source, l.target]) {
      const b = this.host.bookOf(end.book);
      const chunk = b && this.host.lines.existingPeek(b.key, end.line);
      if (!chunk?.length) continue;
      let ix = this.chunkIndexes.get(chunk);
      if (!ix) this.chunkIndexes.set(chunk, (ix = linkMatchIndex(chunk)));
      const m = matchLink(l, ix);
      if (m === "same-link") return m;
      best ??= m;
    }
    return best;
  }
  private readonly chunkIndexes = new WeakMap<readonly Link[], LinkMatchIndex>();

  /** Loads the database links around the given project links, so validation can match them. */
  async loadAround(links: Iterable<Link>): Promise<void> {
    const need = new Map<string, Set<number>>();
    for (const l of links) {
      if (l.status === "deleted" || l.provenance === "db" || l.provenance === "file") continue;
      for (const end of [l.source, l.target]) {
        const b = this.host.bookOf(end.book);
        if (b) need.set(b.key, (need.get(b.key) ?? new Set()).add(Math.floor(end.line / CHUNK)));
      }
    }
    for (const [key, chunks] of need) for (const c of chunks) await this.host.lines.loadExisting(key, c * CHUNK, c * CHUNK);
  }

  forgetSummary(): void {
    this.summary.value = null;
    this.list.value = null;
    this.selected.value = new Set();
  }
}
