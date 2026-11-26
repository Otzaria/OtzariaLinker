import type { ReadonlySignal, Signal } from "@preact/signals";
import type { SourceBook } from "../core/books";
import type { BookRef, Link } from "../core/links/model";
import { validateLink, type ValidationContext } from "../core/links/validate";
import { applyRangeEdit, cancelContinuationEdit, fillRanges, planContinuation, rangeMarkers, suggestEnd, trimBefore, type ContinueMode, type ContinuePlan, type MarkerBasis, type RangeBook, type RangeEdit, type RangeSide } from "../linking/ranges";
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
  /** the export's rules (validate.ts) as the store sees them: whether a range is accepted for a link (#44) */
  validation?(): ValidationContext;
  /** a fresh id for a link the user makes */
  newLinkId?(): string;
  /** heRef_2 the builder would give a target line */
  autoHeRef?(t: { bookKey: string; line: number }): string;
  /** true for a link the open database already holds (the same two lines) */
  inDatabase?(l: Link): boolean;
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

  /**
   * The builder's "until the next link": the end for a range starting at `start` (null: the book is not open). `basis`
   * is v3's rangeEndBasis (F-079): what the range stops before; "book" runs it to the book's last line.
   */
  async suggestEnd(bookKey: string, side: RangeSide, start: number, editing?: string, basis: MarkerBasis = "auto"): Promise<number | null> {
    const book = await this.book(bookKey);
    if (!book || book.lineCount <= 0) return null;
    return suggestEnd(start, rangeMarkers(this.links(), book, side, basis, editing), book);
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
    this.host.notify("success", `הושלמו הטווחים של ${linksCount(n)} ב"${title}".`, undefined, this.undoAction());
    return n;
  }

  /**
   * "This passage continues the previous one" (V7 §2.13, issue #44): the PREVIEW of what marking `line` as the
   * continuation of the passage before it would do (linking/ranges.ts planContinuation). Nothing changes until
   * `applyContinue`. A range is extended only where the export accepts it for that link — the same validateLink the
   * check and the export run, so a Sefaria side of a submission or a one-line type gets an independent link instead.
   * Null: the book is not open.
   */
  async planContinue(bookKey: string, side: RangeSide, line: number, mode: ContinueMode = "extend"): Promise<ContinuePlan | null> {
    const book = await this.book(bookKey);
    if (!book) return null;
    let seq = 0;
    const ctx = this.host.validation?.();
    return planContinuation(this.links(), book, side, line, {
      mode,
      newId: () => this.host.newLinkId?.() ?? `c:${Date.now().toString(36)}:${(++seq).toString(36)}`,
      rangeRefused: ctx ? (before, after) => newError(before, after, ctx) : undefined,
      exists: this.host.inDatabase ? (l) => this.host.inDatabase!(l) : undefined,
      heRef2: this.host.autoHeRef ? (l) => this.host.autoHeRef!({ bookKey, line: l }) : undefined,
    });
  }

  /**
   * Applies a previewed continuation as ONE undoable step. A heading between the two passages is a structural boundary:
   * without `crossHeading` nothing changes, and the user is told why (null). Returns the number of links made or changed.
   */
  applyContinue(plan: ContinuePlan, opts: { crossHeading?: boolean } = {}): number | null {
    if (plan.refused) {
      this.host.notify("info", plan.refused === "heading-line" ? "השורה היא שורת כותרת, ואוצריא משמיטה קישור אליה. בחרו את שורת התוכן שאחריה." : "אין קישור בשורות שלפני השורה הזו בצד הזה, ולכן אין ממה להמשיך. צרו קישור לקטע הקודם, ואז סמנו את ההמשך.");
      return null;
    }
    if (plan.headings.length && !opts.crossHeading) {
      this.host.notify("warning", `בין הקטע הקודם (שורה ${plan.fromLine! + 1}) לשורה ${plan.line + 1} יש כותרת (שורה ${plan.headings.map((h) => h + 1).join(", ")}), כלומר יחידה אחרת. כדי להמשיך בכל זאת, אשרו את המעבר בתצוגה המקדימה.`);
      return null;
    }
    const s = this.host.linkState.value;
    const changes: Change[] = [];
    for (const it of plan.items) {
      if (!it.after) continue;
      // the preview may be older than the project: a link changed since is not overwritten
      if (it.action === "extend" && s.links.get(it.prev.id) !== it.prev) continue;
      if (it.action === "copy" && s.links.has(it.after.id)) continue;
      changes.push(it.action === "extend" ? { id: it.prev.id, before: it.prev, after: it.after } : { id: it.after.id, after: it.after });
    }
    if (!changes.length) {
      this.host.notify("info", "לא נוצר ולא השתנה אף קישור: כל הקישורים של הקטע הקודם כבר מגיעים לשורה הזו, או שקישור כזה כבר קיים.");
      return 0;
    }
    this.host.linkState.value = commit(s, `המשך לקטע הקודם (${linksCount(changes.length)})`, changes);
    this.host.notify("success", `השורה ${plan.line + 1} סומנה כהמשך של שורה ${plan.fromLine! + 1} (${linksCount(changes.length)}).`, undefined, this.undoAction());
    return changes.length;
  }

  /** Cancels the continuation of these links (an extended range shrinks back, a copy is removed), as one undoable step. */
  cancelContinuation(ids: readonly string[]): number {
    const s = this.host.linkState.value;
    const changes: Change[] = [];
    for (const id of ids) {
      const l = s.links.get(id);
      if (!l || l.status === "deleted") continue;
      const after = cancelContinuationEdit(l);
      if (after === undefined) continue;
      changes.push(after === null ? { id, before: l } : { id, before: l, after });
    }
    if (changes.length) this.host.linkState.value = commit(s, `ביטול ההמשך לקטע הקודם (${linksCount(changes.length)})`, changes);
    return changes.length;
  }

  /**
   * The "ביטול" of a success notice: it undoes the action it reports only while nothing else was done since —
   * clicked later, a plain undo would take back another action (like the delete notice, store.ts deleteLinks).
   * Called right after the commit, so the revision it captures is the action's own.
   */
  private undoAction(): { label: string; run: () => void } {
    const at = this.host.linkState.peek().revision;
    return { label: "ביטול", run: () => void (this.host.linkState.peek().revision === at && this.host.undo()) };
  }

  private links(): Link[] {
    return [...this.host.linkState.value.links.values()];
  }

  private toChanges(edits: readonly RangeEdit[]): Change[] {
    return edits.map((e) => ({ id: e.link.id, before: e.link, after: applyRangeEdit(e.link, e.side, e.after) }));
  }
}

/** The first ERROR the export gives the extended link that it did not give the link before (null: none), in the user's words. */
function newError(before: Link, after: Link, ctx: ValidationContext): string | null {
  const had = new Set(validateLink(before, ctx).filter((p) => p.severity === "error").map((p) => p.code));
  return validateLink(after, ctx).find((p) => p.severity === "error" && !had.has(p.code))?.message ?? null;
}
