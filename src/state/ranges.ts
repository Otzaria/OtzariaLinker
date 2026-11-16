import type { ReadonlySignal, Signal } from "@preact/signals";
import type { SourceBook } from "../core/books";
import type { BookRef, Link } from "../core/links/model";
import { applyRangeEdit, fillRanges, rangeMarkers, suggestEnd, trimBefore, type RangeBook, type RangeEdit, type RangeSide } from "../linking/ranges";
import { commit, linksCount, type Change, type LinkState } from "./history";
import type { LineStore } from "./lines";
import type { BooksService, CallOptions } from "./services";
import type { NoticeKind } from "./store";

/*
 * Range actions of the project (v3 F-054/F-064/F-084/F-105): "until the next link" for the builder,
 * cutting a range that a new link would fall inside, and range completion for a whole book. The rules
 * are pure (linking/ranges.ts); this class feeds them the project's links and the book's headings
 * (read from the worker once per book) and commits each action as ONE undoable step.
 * Kept out of store.ts on purpose, like alt-toc.ts and db-links.ts.
 */
export interface RangesHost {
  readonly linkState: Signal<LinkState>;
  readonly books: ReadonlySignal<Map<string, SourceBook>>;
  /** the line count of a text book is known once the reader has read it; `peek` gives its loaded lines */
  readonly lines: Pick<LineStore, "count" | "peek">;
  sameBook(ref: BookRef, bookKey: string): boolean;
  notify(kind: NoticeKind, text: string, details?: string[], action?: { label: string; run: () => void }): void;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>): Promise<T | null>;
  undo(): void;
  /** the one answer to "is this a Sefaria book" (AppStore.isSefariaOwned, core/links/sefaria-owned.ts) */
  isSefariaOwned?(book: { readonly title: string; readonly key?: string }): boolean;
  /** what the export is for: a submission to the library refuses a range on a Sefaria side */
  readonly exportPurpose?: ReadonlySignal<"submission" | "private">;
}

export class RangesState {
  /** heading lines per book key; a book's text does not change while it is open */
  private readonly headingCache = new Map<string, ReadonlySet<number>>();

  constructor(
    private readonly host: RangesHost,
    private readonly service: Pick<BooksService, "headings">,
  ) {}

  /** The book as the rules see it; null when it is not open. Its headings are read once (a worker call). */
  async book(bookKey: string): Promise<RangeBook | null> {
    const b = this.host.books.value.get(bookKey);
    if (!b) return null;
    let headings = this.headingCache.get(bookKey);
    if (!headings) {
      const hs = await this.host.runTask("קורא את כותרות הספר…", (opts) => this.service.headings(bookKey, opts));
      if (hs === null) return null;
      headings = new Set(hs.map((h) => h.line));
      this.headingCache.set(bookKey, headings);
    }
    return { owns: (ref) => this.host.sameBook(ref, bookKey), lineCount: b.lineCount ?? this.host.lines.count(bookKey) ?? 0, headings };
  }

  /** The builder's "until the next link": the end for a range starting at `start` (null: the book is not open). */
  async suggestEnd(bookKey: string, side: RangeSide, start: number, editing?: string): Promise<number | null> {
    const book = await this.book(bookKey);
    if (!book || book.lineCount <= 0) return null;
    return suggestEnd(start, rangeMarkers(this.links(), book, side, "auto", editing), book);
  }

  /**
   * Edits that cut every range a new link at (`bookKey`, `start`) would fall inside. Synchronous, so the
   * store can put them in the same step as the new link; a cut range must still not end on a heading
   * (Otzaria drops it), so the headings are the ones already read for the book, else the heading lines
   * right above `start` as far as the reader has loaded them — the lines the user is looking at.
   */
  trimFor(bookKey: string, side: RangeSide, start: number, exclude?: string): Change[] {
    const headings = this.headingCache.get(bookKey) ?? this.loadedHeadingsAbove(bookKey, start);
    const book: RangeBook = { owns: (ref) => this.host.sameBook(ref, bookKey), lineCount: 0, headings };
    return this.toChanges(trimBefore(this.links(), book, side, start, exclude));
  }

  /** The run of heading lines that ends right above `start`, among the lines the reader has loaded. */
  private loadedHeadingsAbove(bookKey: string, start: number): Set<number> {
    const out = new Set<number>();
    for (let i = start - 1; i >= 0; i--) {
      const l = this.host.lines.peek(bookKey, i);
      if (!l || l.heading == null) break;
      out.add(i);
    }
    return out;
  }

  /** Range completion for one book and side, as one undoable step. Returns the number of links changed (null: not run). */
  async fill(bookKey: string, side: RangeSide, onlyRanged: boolean): Promise<number | null> {
    const book = await this.book(bookKey);
    if (!book) return null;
    const title = this.host.books.value.get(bookKey)?.title ?? "";
    // a range on a Sefaria side drifts (the sync remaps only its start) and a submission refuses it
    // (validate.ts sefaria/range-side): the completion would only make errors (product audit F1)
    if (this.host.exportPurpose?.value !== "private" && this.host.isSefariaOwned?.({ title, key: bookKey })) {
      this.host.notify("warning", `הטווחים לא הושלמו: "${title}" הוא ספר של ספריא, והספרייה לא מקבלת טווח בצד שלו (סוף הטווח לא מתעדכן איתה). אם הקישורים לשימושכם בלבד, בחרו בחלון הייצוא "שימוש פרטי" ונסו שוב.`);
      return null;
    }
    const r = fillRanges(this.links(), book, side, { onlyRanged });
    if (r.skippedNoText) {
      this.host.notify("warning", `אורך הספר "${title}" עדיין לא ידוע, ולכן הטווחים לא הושלמו. פתחו את הספר בקורא ונסו שוב.`);
      return null;
    }
    if (!r.edits.length) {
      this.host.notify("info", "אין מה להשלים: כל הטווחים כבר מסתיימים שורה לפני הקישור הבא.");
      return 0;
    }
    const n = r.edits.length;
    this.host.linkState.value = commit(this.host.linkState.value, `השלמת טווחים ב"${title}" (${linksCount(n)})`, this.toChanges(r.edits));
    this.host.notify("success", `הושלמו הטווחים של ${linksCount(n)} ב"${title}".`, undefined, { label: "ביטול", run: () => this.host.undo() });
    return n;
  }

  private links(): Link[] {
    return [...this.host.linkState.value.links.values()];
  }

  private toChanges(edits: readonly RangeEdit[]): Change[] {
    return edits.map((e) => ({ id: e.link.id, before: e.link, after: applyRangeEdit(e.link, e.side, e.after) }));
  }
}
