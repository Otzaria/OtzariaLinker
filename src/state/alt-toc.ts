import { computed, type ReadonlySignal, type Signal } from "@preact/signals";
import { AUTOMATIC_KEYS, isSefariaSourceName, type AltTocBook, type AltTocContext, type AltTocOrigin, type AltTocStructure, type LibraryAltTocStructure } from "../core/alt-toc/model";
import type { BookHeading, SourceBook } from "../core/books";
import { planAltTocExport, type AltTocExportPlan } from "../formats/alt-toc/export";
import { parseAltTocJson, titleFromAltTocFileName } from "../formats/alt-toc/file";
import { altTocChange, commit, type LinkState } from "./history";
import { CHUNK, type LineStore } from "./lines";
import type { BooksService, CallOptions } from "./services";
import type { NoticeKind } from "./store";

/*
 * The project's alternative TOC structures (alt_toc), per book title. They live in the same
 * history as the links (LinkState.altToc, history.commit), so saving the editor, importing a file
 * and opening a project are each ONE undoable action. Kept out of store.ts on purpose: the store
 * only creates this object and routes documents and the export to it.
 */
export interface AltTocHost {
  readonly linkState: Signal<LinkState>;
  readonly books: ReadonlySignal<Map<string, SourceBook>>;
  readonly booksByTitle: ReadonlySignal<Map<string, SourceBook[]>>;
  readonly lines: LineStore;
  notify(kind: NoticeKind, text: string, details?: string[]): void;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>): Promise<T | null>;
}

/** What the library database already has for a book, split for the editor. */
export interface LibraryAltToc {
  /** structures a file may carry — the editor starts from these */
  editable: LibraryAltTocStructure[];
  /** structures SeforimLibrary builds by itself (AUTOMATIC_KEYS): shown, not loaded by default */
  automatic: LibraryAltTocStructure[];
}

export class AltTocState {
  /** every book with structures in the project, by title order */
  readonly list = computed(() => [...this.host.linkState.value.altToc.values()].sort((a, b) => (a.title < b.title ? -1 : 1)));
  /** number of structures in the project */
  readonly count = computed(() => this.list.value.reduce((n, b) => n + b.structures.length, 0));

  constructor(
    private readonly host: AltTocHost,
    private readonly service: BooksService,
  ) {}

  of(title: string): AltTocBook | undefined {
    return this.host.linkState.value.altToc.get(title);
  }

  /**
   * Replaces a book's structures as ONE undoable action. `origin` says where they came from when
   * the book is new to the project (or, for an import, always); otherwise the book keeps its origin.
   */
  set(title: string, structures: readonly AltTocStructure[], opts: { origin?: AltTocOrigin; label?: string; replaceOrigin?: boolean } = {}): void {
    const prev = this.of(title);
    const origin = (opts.replaceOrigin ? opts.origin : prev?.origin ?? opts.origin) ?? "user";
    const book: AltTocBook = { title, origin, structures: [...structures] };
    this.commit(opts.label ?? `עריכת מבני כותרות: ${title}`, [altTocChange(this.host.linkState.value, title, book)]);
  }

  /** Takes the book out of the project: the export will not write a file for it. */
  drop(title: string): void {
    if (!this.of(title)) return;
    this.commit(`הסרת מבני הכותרות של ${title} מהפרויקט`, [altTocChange(this.host.linkState.value, title, null)]);
  }

  /** An imported `<title>_alt_toc.json`: replaces that book's structures in the project. */
  importFile(path: string, text: string): void {
    const title = titleFromAltTocFileName(path);
    if (!title) return void this.host.notify("error", `"${path}": שם קובץ מבני כותרות חייב להסתיים ב־‎_alt_toc.json, כי ממנו אוצריא יודעת לאיזה ספר הוא שייך.`);
    const parsed = parseAltTocJson(text);
    this.set(title, parsed.structures, { origin: "file", replaceOrigin: true, label: `ייבוא ${title}_alt_toc.json (${parsed.structures.length} מבנים)` });
    const details = parsed.issues.slice(0, 200).map((i) => i.message);
    if (parsed.generatorRejectsFile)
      this.host.notify("error", `"${path}": אוצריא הייתה מדלגת על הקובץ הזה כולו כמו שהוא. מה שאפשר היה לקרוא נטען; בייצוא הקובץ ייכתב מחדש תקין.`, details);
    else if (parsed.issues.length) this.host.notify("warning", `"${path}": נטענו ${parsed.structures.length} מבני כותרות, עם ${parsed.issues.length} הערות.`, details);
    else this.host.notify("success", `נטענו ${parsed.structures.length} מבני כותרות מ־"${path}".`);
    if (!this.host.booksByTitle.value.get(title)?.length) this.host.notify("info", `הספר "${title}" עדיין לא פתוח. פתחו אותו כדי לבדוק את מספרי השורות.`);
  }

  /** The structures the book's database already has (null: its source has none to offer, or reading failed). */
  async fromLibrary(bookKey: string): Promise<LibraryAltToc | null> {
    const got = await this.host.runTask("קורא את מבני הכותרות מהמסד…", (opts) => this.service.altToc(bookKey, opts));
    if (!got) return null;
    return { editable: got.filter((s) => !AUTOMATIC_KEYS.includes(s.key)), automatic: got.filter((s) => AUTOMATIC_KEYS.includes(s.key)) };
  }

  /** Every heading line of an open book (for "fill from the book's headings"). */
  async headings(bookKey: string): Promise<BookHeading[] | null> {
    return this.host.runTask("קורא את כותרות הספר…", (opts) => this.service.headings(bookKey, opts));
  }

  /** The open book a title names (a non-personal one first, as the generator matches titles exactly). */
  bookOf(title: string): SourceBook | undefined {
    const hits = this.host.booksByTitle.value.get(title);
    return hits?.find((b) => b.origin !== "personal") ?? hits?.[0];
  }

  /** What validation knows about the book: its length, which lines exist, whether it is Sefaria's. */
  context(title: string): AltTocContext {
    const b = this.bookOf(title);
    if (!b) return {};
    const count = b.lineCount ?? this.host.lines.count(b.key);
    return {
      ...(count !== undefined && { lineCount: count }),
      lineExists: (i) => this.host.lines.peek(b.key, i)?.existsInDb,
      sefaria: isSefariaSourceName(b.sourceName),
    };
  }

  /** Loads the lines the structures point at, so validation can check them (export, editor save). */
  async loadLines(titles: readonly string[] = this.list.value.map((b) => b.title)): Promise<void> {
    for (const title of titles) {
      const b = this.bookOf(title);
      const book = this.of(title);
      if (!b || !book) continue;
      const chunks = new Set<number>();
      for (const s of book.structures) for (const e of s.entries) if (Number.isInteger(e.line) && e.line >= 1) chunks.add(Math.floor((e.line - 1) / CHUNK));
      await Promise.all([...chunks].map((c) => this.host.lines.load(b.key, c * CHUNK, c * CHUNK)));
    }
  }

  plan(): AltTocExportPlan {
    return planAltTocExport(this.list.value, (t) => this.context(t));
  }

  private commit(label: string, changes: Parameters<typeof commit>[4]): void {
    this.host.linkState.value = commit(this.host.linkState.value, label, [], Date.now(), changes);
  }
}
