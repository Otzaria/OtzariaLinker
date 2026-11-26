import { signal, type ReadonlySignal, type Signal } from "@preact/signals";
import { sourceIdOfBookKey, type SourceBook } from "../core/books";
import type { BookRef, Link } from "../core/links/model";
import { stripTags } from "../core/text/html";
import { candidateLines, contentUnits, coverageCounts, coverageSummary, doubtfulLines, MAX_BOOK_LINES, type CoverageBook, type CoverageReport, type CoverageSummary, type LinksReading } from "../linking/coverage";
import { COVERAGE_RANGES_MAX, type ProjectCoverage } from "../projects/project-format";
import type { LinkState } from "./history";
import type { LineStore } from "./lines";
import type { QualityState } from "./quality";
import type { SuggestionsState } from "./suggestions";
import type { BooksService, CallOptions, OpenedSource } from "./services";

/** re-exported for the screens (they do not import projects/) */
export { COVERAGE_RANGES_MAX, type ProjectCoverage };

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
  /** the run on the screen and the user's decisions on it: its pending suggestions are the candidates */
  readonly suggestions: Pick<SuggestionsState, "run" | "state">;
  /** the last quality report: the links it flags are the doubtful ones (as of its last run) */
  readonly quality: Pick<QualityState, "report">;
  /** the open sources: a book of a text-files source has no database to read links from (#42 C14); absent = unknown */
  readonly sources?: ReadonlySignal<readonly OpenedSource[]>;
}

export interface CoverageOptions {
  /**
   * Count the links the open database already has (default: yes — a commentary the library already links is not
   * "100% unlinked"). Read through the same call the max-link job uses (BooksService.existingLinks); a source with
   * no links (text files) gives none. False: the project's own links only.
   */
  includeDb?: boolean;
  /** mark the lines of pending suggestions 'candidate' (default: yes) */
  includeCandidates?: boolean;
  /** mark the links of the last QA report 'doubtful' (default: yes, when there is a report) */
  includeQa?: boolean;
  /** other links to count, already as `Link`s */
  extraLinks?: readonly Link[];
  /** lines that cannot carry a link, instead of the ones read from the book (blank, fewer than two Hebrew letters) */
  unsuitable?: ReadonlySet<number>;
}

/** One book of the table: its buckets (no ranges), and whether the headings and the text were read for it. */
export interface CoverageRow {
  key: string;
  title: string;
  lineCount: number;
  counts: Omit<CoverageSummary, "ranges">;
  /** what is known about the database's links of this book: "failed" and "unknown" are not "no links" (LinksReading) */
  links: LinksReading;
  /**
   * false: the book's headings were not read (`headings: false`) and no text was, so its headings count as unlinked lines and
   * blank lines are not set aside — an upper bound of what is missing. true: headings are not suitable (blank lines still are not read).
   */
  exact: boolean;
}

export interface CoverageTableOptions {
  signal?: AbortSignal;
  /** read each book's headings (a worker call per book); default false: the table of a whole database stays a read of its link indexes */
  headings?: boolean;
  /** count the database's own links (default true) */
  includeDb?: boolean;
}

/** A cancel (the user's, or the caller's signal) is not a failure of the read. */
const isCancel = (err: unknown, signal?: AbortSignal): boolean => {
  const e = err as { code?: string; name?: string } | null;
  return signal?.aborted === true || e?.code === "cancelled" || e?.name === "AbortError";
};

/**
 * The database's links of a book, and what the read says about them: a failure is NOT an empty list (the book would look as if it had
 * no links); a cancel is rethrown for the caller to treat as a cancel. `unread` (SourceBook.linksUnread): the database has a table of
 * links it cannot read — the links read are counted, but the answer is "unknown", never "none" or a count that looks complete.
 */
/** The book comes from loose text files (no database): there are no database links of it (#42 C14). */
function fromTextFiles(host: CoverageHost, bookKey: string): boolean {
  const id = sourceIdOfBookKey(bookKey);
  return host.sources?.peek().find((s) => s.info.id === id)?.info.kind === "text-files";
}

async function readDbLinks(read: () => Promise<Link[]>, signal?: AbortSignal, unread?: string): Promise<{ links: Link[]; reading: LinksReading }> {
  try {
    const links = await read();
    if (unread) return { links, reading: { state: "unknown", why: "unreadable", message: unread } };
    return { links, reading: links.length ? { state: "counted", count: links.length } : { state: "none" } };
  } catch (err) {
    if (isCancel(err, signal)) throw err;
    return { links: [], reading: { state: "failed", message: err instanceof Error ? err.message : String(err) } };
  }
}

export class CoverageState {
  /**
   * The last coverage of each book, by title: counted in this session, or restored from the project (as of its save). Saved with the
   * project (ProjectFile.coverage) so that a reopened project shows where it stood until the book is counted again.
   */
  readonly saved = signal<ReadonlyMap<string, ProjectCoverage>>(new Map());
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

  /**
   * The coverage of MANY books — a whole database for the repository screen — one row at a time, as the caller asks for it, so the
   * first rows are there at once and a stop (the signal, or leaving the loop) costs nothing more. Index-based: a book's links are
   * read through its database's link indexes (BooksService.existingLinks), not its text; the project's links are counted too.
   * A book that is not open, or whose length is not known, has no row. The rows are not cached: a table is a moment.
   */
  async *rows(bookKeys: readonly string[], options: CoverageTableOptions = {}): AsyncGenerator<CoverageRow> {
    // the project's links by the key of each end, once: a book reads only its own (and the unresolved ones that name its title), not all of them
    const byKey = new Map<string, Link[]>();
    const unresolved = new Map<string, Link[]>();
    const put = (m: Map<string, Link[]>, k: string, l: Link) => {
      const list = m.get(k);
      if (!list) m.set(k, [l]);
      else if (list[list.length - 1] !== l) list.push(l);
    };
    for (const l of this.host.linkState.value.links.values())
      for (const ref of [l.source.book, l.target.book]) {
        put(byKey, ref.key, l);
        if (ref.key.startsWith("unresolved:")) put(unresolved, ref.title, l);
      }
    for (const key of bookKeys) {
      if (options.signal?.aborted) return;
      const b = this.host.books.value.get(key);
      if (!b) continue;
      const lineCount = b.lineCount ?? this.host.lines.count(key) ?? (await this.host.lines.learnCount(key)) ?? 0;
      if (lineCount <= 0) continue;
      // a database that reports an absurd length: a row that says so, with no per-book reads (headings, links) at all
      if (lineCount > MAX_BOOK_LINES) {
        yield { key, title: b.title, lineCount, counts: coverageCounts([], { owns: () => false, lineCount, headings: new Set() }), links: { state: "unknown", why: "not-read" }, exact: false };
        continue;
      }
      let headings: ReadonlySet<number> = new Set();
      if (options.headings) {
        const hs = await this.service.headings(key, options.signal ? { signal: options.signal } : {});
        headings = new Set(hs.map((h) => h.line));
      }
      let read: { links: Link[]; reading: LinksReading };
      if (options.includeDb === false) read = { links: [], reading: { state: "unknown", why: "not-requested" } };
      else {
        try {
          read = await readDbLinks(() => this.service.existingLinks(key, 0, Number.MAX_SAFE_INTEGER, options.signal ? { signal: options.signal } : {}), options.signal, b.linksUnread);
        } catch {
          return; // cancelled: the table stops
        }
      }
      if (options.signal?.aborted) return;
      const book: CoverageBook = { owns: (ref) => this.host.sameBook(ref, key), lineCount, headings };
      const mine = new Set([...(byKey.get(key) ?? []), ...(unresolved.get(b.title) ?? [])]);
      yield { key, title: b.title, lineCount, counts: coverageCounts([...mine, ...read.links], book, read.reading), links: read.reading, exact: options.headings === true };
    }
  }

  /** The rows of rows(), all of them (or those before the signal stopped it). */
  async table(bookKeys: readonly string[], options: CoverageTableOptions = {}): Promise<CoverageRow[]> {
    const out: CoverageRow[] = [];
    for await (const r of this.rows(bookKeys, options)) out.push(r);
    return out;
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
  async summary(bookKey: string, options: CoverageOptions = {}): Promise<CoverageReport | null> {
    const b = this.host.books.value.get(bookKey);
    if (!b) return null;
    // an absurd reported length is answered before anything is read or allocated for it (the result says tooLarge, and is not saved)
    const known = b.lineCount ?? this.host.lines.count(bookKey) ?? (await this.host.lines.learnCount(bookKey)) ?? 0;
    if (known > MAX_BOOK_LINES) return { ...coverageSummary([], { owns: () => false, lineCount: known, headings: new Set() }), links: { state: "unknown", why: "not-read" } };
    const suitable = options.unsuitable ? null : await this.suitable(bookKey);
    if (!options.unsuitable && !suitable) return null;
    const first = await this.book(bookKey, options.unsuitable);
    if (!first || first.lineCount <= 0) return null;
    // a line with no row (a hole in a slice, an empty heading the generator did not create) or with no letters is not suitable
    let unsuitable = options.unsuitable;
    if (!unsuitable) {
      const set = new Set<number>();
      for (let i = 0; i < first.lineCount; i++) if (!suitable!.has(i)) set.add(i);
      unsuitable = set;
    }
    const owns = first.owns;
    const run = this.host.suggestions.run.value;
    const state = this.host.suggestions.state.value;
    const candidates = options.includeCandidates === false || !run ? undefined : candidateLines(run.result.suggestions, (id) => state.get(id) === "pending", owns, first.lineCount);
    const report = this.host.quality.report.value;
    const doubtful = options.includeQa === false || !report ? undefined : doubtfulLines(report.issues, owns, first.lineCount);
    let db: readonly Link[] = [];
    let reading: LinksReading = { state: "unknown", why: "not-requested" };
    if (options.includeDb !== false && fromTextFiles(this.host, bookKey)) reading = { state: "no-database" };
    else if (options.includeDb !== false) {
      // a failed read is part of the answer (links.state "failed"), never an empty list; a cancel answers null
      const got = await this.host.runTask("קורא את הקישורים של הספר במסד…", (opts) => readDbLinks(() => this.service.existingLinks(bookKey, 0, Number.MAX_SAFE_INTEGER, opts), opts.signal, b.linksUnread));
      if (got === null) return null;
      db = got.links;
      reading = got.reading;
    }
    const projectLinks = [...this.host.linkState.value.links.values(), ...db, ...(options.extraLinks ?? [])];
    // content units per line: the links and the pending suggestions of the line (a line of several units with one link is partial)
    const units = run ? contentUnits(projectLinks, options.includeCandidates === false ? [] : run.result.suggestions, (id) => state.get(id) === "pending", owns, first.lineCount) : undefined;
    const book: CoverageBook = { ...first, unsuitable, ...(candidates && { candidates }), ...(doubtful && { doubtful }), ...(units?.size && { units }) };
    const summary: CoverageReport = { ...coverageSummary(projectLinks, book, reading), links: reading };
    // only the full picture is the project's "coverage": a count without the database's links (not asked for, or the read failed), the
    // candidates or the QA, with other links or another set of unsuitable lines describes something else, and a reopened project would
    // show it as if it were the whole
    const full = (reading.state === "counted" || reading.state === "none" || reading.state === "no-database") && options.includeCandidates !== false && options.includeQa !== false && !options.extraLinks?.length && !options.unsuitable;
    if (full) this.remember(bookKey, book.lineCount, summary);
    return summary;
  }

  private remember(bookKey: string, lines: number, s: CoverageSummary): void {
    const title = this.host.books.value.get(bookKey)?.title;
    if (!title) return;
    const buckets: Record<string, number> = {};
    for (const [k, n] of Object.entries(s.byBucket)) if (n) buckets[k] = n;
    const next = new Map(this.saved.peek());
    next.set(title, { title, lines, buckets, ranges: s.ranges.slice(0, COVERAGE_RANGES_MAX).map((r) => [r.start, r.end]), at: Date.now() });
    this.saved.value = next;
  }

  /** What goes into the project file. */
  snapshot(): ProjectCoverage[] {
    return [...this.saved.value.values()];
  }

  /** What a project file brought: replaces what was held (a project is a different session's moment). */
  restore(list: readonly ProjectCoverage[]): void {
    this.saved.value = new Map(list.map((c) => [c.title, c] as const));
  }
}


