import type { ReadonlySignal, Signal } from "@preact/signals";
import type { SourceBook } from "../core/books";
import type { BookRef, Link } from "../core/links/model";
import { stripTags } from "../core/text/html";
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
   * Count the links the open database already has (default: yes — a commentary the library already links is not
   * "100% unlinked"). Read through the same call the max-link job uses (BooksService.existingLinks); a source with
   * no links (text files) gives none. False: the project's own links only.
   */
  includeDb?: boolean;
  /** other links to count, already as `Link`s */
  extraLinks?: readonly Link[];
  /** lines that cannot carry a link, instead of the ones read from the book (blank, fewer than two Hebrew letters) */
  unsuitable?: ReadonlySet<number>;
}

export class CoverageState {
  private readonly headingCache = new Map<string, ReadonlySet<number>>();
  private readonly unsuitableCache = new Map<string, ReadonlySet<number>>();

  constructor(
    private readonly host: CoverageHost,
    private readonly service: Pick<BooksService, "headings" | "lines" | "existingLinks">,
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

  /** The lines that can carry a link: at least two Hebrew letters (as the headings engine skips the rest). Read once per book. */
  private async suitable(bookKey: string): Promise<ReadonlySet<number> | null> {
    let set = this.unsuitableCache.get(bookKey);
    if (!set) {
      const lines = await this.host.runTask("קורא את שורות הספר…", (opts) => this.service.lines(bookKey, 0, Number.MAX_SAFE_INTEGER, opts));
      if (lines === null) return null;
      set = new Set(lines.filter((l) => (stripTags(l.text).match(/[\u05d0-\u05ea]/g)?.length ?? 0) >= 2).map((l) => l.index));
      this.unsuitableCache.set(bookKey, set);
    }
    return set;
  }

  /**
   * The coverage of a book by the project's links as they are now, and (default) the open database's links of the book;
   * null when the book is not open, its length is not known, or the read was cancelled.
   */
  async summary(bookKey: string, options: CoverageOptions = {}): Promise<CoverageSummary | null> {
    const suitable = options.unsuitable ? null : await this.suitable(bookKey);
    if (!options.unsuitable && !suitable) return null;
    const first = await this.book(bookKey, options.unsuitable);
    if (!first || first.lineCount <= 0) return null;
    // a line with no row (a hole in a slice, an empty heading the generator did not create) or with no letters is not suitable
    const unsuitable = options.unsuitable ?? new Set(Array.from({ length: first.lineCount }, (_, i) => i).filter((i) => !suitable!.has(i)));
    const book: CoverageBook = { ...first, unsuitable };
    let db: readonly Link[] = [];
    if (options.includeDb !== false) {
      const got = await this.host.runTask("קורא את הקישורים של הספר במסד…", (opts) => this.service.existingLinks(bookKey, 0, Number.MAX_SAFE_INTEGER, opts).catch(() => [] as Link[]));
      if (got === null) return null;
      db = got;
    }
    return coverageSummary([...this.host.linkState.value.links.values(), ...db, ...(options.extraLinks ?? [])], book);
  }
}
