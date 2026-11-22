import type { ReadonlySignal, Signal } from "@preact/signals";
import type { SourceBook } from "../core/books";
import type { BookRef, Link } from "../core/links/model";
import { coverageSummary, type CoverageBook, type CoverageSummary } from "../linking/coverage";
import type { LinkState } from "./history";
import type { LineStore } from "./lines";
import type { BooksService, CallOptions } from "./services";

/*
 * Coverage of a book by the project's links (issue #17, linking/coverage.ts): which lines are linked, partly
 * covered, linked to several places, or still unlinked. Data only for now — the screens that list the ranges and
 * jump to them are built on top. The headings are read from the worker once per book (a book's text does not
 * change while it is open); the links are read at the moment of the question, so approving or undoing a link
 * changes the next answer. Kept out of store.ts on purpose, like ranges.ts.
 */
export interface CoverageHost {
  readonly linkState: Signal<LinkState>;
  readonly books: ReadonlySignal<Map<string, SourceBook>>;
  /** the line count of a text book is learned by a few small reads (LineStore.learnCount) when nothing has read it yet */
  readonly lines: Pick<LineStore, "count" | "learnCount">;
  sameBook(ref: BookRef, bookKey: string): boolean;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>): Promise<T | null>;
}

export interface CoverageOptions {
  /**
   * Count the links the database already has as coverage. The project's links never include them (they live in
   * the database's own list, DbLinksState), so a caller that wants them passes them here, already as `Link`s.
   */
  extraLinks?: readonly Link[];
  /** lines the caller knows to be blank or too short to link (CoverageBook.unsuitable) */
  unsuitable?: ReadonlySet<number>;
}

export class CoverageState {
  private readonly headingCache = new Map<string, ReadonlySet<number>>();

  constructor(
    private readonly host: CoverageHost,
    private readonly service: Pick<BooksService, "headings">,
  ) {}

  /** The book as the coverage rules see it; null when it is not open, or the read was cancelled. */
  async book(bookKey: string, unsuitable?: ReadonlySet<number>): Promise<CoverageBook | null> {
    const b = this.host.books.value.get(bookKey);
    if (!b) return null;
    let headings = this.headingCache.get(bookKey);
    if (!headings) {
      const hs = await this.host.runTask("קורא את כותרות הספר…", (opts) => this.service.headings(bookKey, opts));
      if (hs === null) return null;
      headings = new Set(hs.map((h) => h.line));
      this.headingCache.set(bookKey, headings);
    }
    const lineCount = b.lineCount ?? this.host.lines.count(bookKey) ?? (await this.host.lines.learnCount(bookKey)) ?? 0;
    return { owns: (ref) => this.host.sameBook(ref, bookKey), lineCount, headings, ...(unsuitable && { unsuitable }) };
  }

  /** The coverage of a book by the project's links as they are now; null when the book is not open or its length is not known yet. */
  async summary(bookKey: string, options: CoverageOptions = {}): Promise<CoverageSummary | null> {
    const book = await this.book(bookKey, options.unsuitable);
    if (!book || book.lineCount <= 0) return null;
    return coverageSummary([...this.host.linkState.value.links.values(), ...(options.extraLinks ?? [])], book);
  }
}
