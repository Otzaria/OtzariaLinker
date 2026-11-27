import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { sourceIdOfBookKey, type SourceBook } from "../core/books";
import type { ConnectionType } from "../core/links/connection-type";
import type { DbLinkFlag, DbLinkSummary, DbLinksUnavailable } from "../core/links/db-links";
import type { UserPair } from "../linking/plan";
import { discoverPairs, type DiscoveryBook, type PairProposal } from "../linking/discovery";
import { linksReadingText, type CoverageReport } from "../linking/coverage";
import type { CoverageRow, CoverageState } from "./coverage";
import type { BooksService, OpenedSource } from "./services";

/*
 * The analysis of a repository (V6 3.9) — an open database taken as a whole: how many books, how many links, which books have none,
 * which kinds of links, which are flagged — and the books and pairs the user may then send to the guided flow to complete.
 *
 * Nothing is read until the user asks, and nothing is read all at once: the links of the books are counted ONE BOOK AT A TIME through
 * the database's link indexes (BooksService.dbLinkSummary), the rows of the table are small counts (never the links themselves, never
 * the text), the work can be stopped at any book and picked up again where it stopped, and the table fills while it runs. The
 * coverage of a book (how many lines carry a link) is a second, separate read, for the books asked for. No graph, no run: choosing a
 * book or a pair only fills the lists the guided flow is started from (GuidedFlowState.startForBooks).
 */

/** What the table keeps of one book: counts only. */
export interface RepoRow {
  key: string;
  title: string;
  lineCount?: number;
  /** links of the book at either end, and how many of those start or end here (DbLinkSummary) */
  total: number;
  out: number;
  in: number;
  /** links that start in this book, by stored type (each link of the repository is counted once, at its source) */
  typesOut: Partial<Record<ConnectionType, number>>;
  /** the same links by where the other end is: this source, another open source of the library, another open source, a book that is not open */
  ends: { same: number; library: number; other: number; unresolved: number };
  /** per flag, the links of this book that carry it (a link between two books is counted at each of them) */
  flags: { flag: DbLinkFlag; count: number }[];
  /** the books it is most linked to, for the pair suggestions (a commentary is linked to its base) */
  top: { key: string; title: string; links: number }[];
  /** why its links cannot be read (no link table…): it is not counted as having none */
  unavailable?: string;
  /** the lines by what links them, once counted (CoverageRow); `unlinked` is an upper bound unless `exact` (the book's headings were read) */
  coverage?: { suitable: number; unlinked: number; linked: number; partial: number; multiple: number; notSuitable: number; exact: boolean; at: number };
  /**
   * why the coverage of this book is NOT shown although it was asked for: the read of its links (linking/coverage.ts LinksReading, PR 2's
   * contract) failed or was not made, and "100% unlinked" would say that the book has no links when nobody knows. Unknown is not zero.
   */
  coverageUnknown?: string;
  /** coverageUnknown because the read FAILED (not merely not made): the list says so */
  coverageFailed?: true;
}

/** A book is "suspicious" when at least this share of its links carry a flag (and at least SUSPICIOUS_MIN of them). */
export const SUSPICIOUS_SHARE = 0.05;
export const SUSPICIOUS_MIN = 3;
const TOP = 8;
/** the table is told of new rows at most this often while it fills (ms) */
const FLUSH_MS = 150;

export interface RepoTotals {
  books: number;
  /** books whose links were counted so far */
  counted: number;
  /** links in the repository, each once (counted at its source book) */
  links: number;
  noLinks: number;
  unavailable: number;
  byType: [ConnectionType, number][];
  ends: { same: number; library: number; other: number; unresolved: number };
  /** per flag: how many books carry it and the sum of their counts */
  flags: { flag: DbLinkFlag; books: number; links: number }[];
  flaggedBooks: number;
  suspicious: number;
}

export interface RepositoryHost {
  readonly sources: ReadonlySignal<readonly OpenedSource[]>;
  readonly coverage: Pick<CoverageState, "rows" | "summary">;
  /** the books open in the app: a null coverage of one of them is a count that was stopped, not a book that is not open */
  readonly books?: ReadonlySignal<ReadonlyMap<string, unknown>>;
  isLibrarySource(sourceId: string): boolean;
}

export type RepoSort = "title" | "links-asc" | "links-desc" | "unlinked-share";

export interface RepoProgress {
  stage: "links" | "coverage";
  done: number;
  total: number;
}

export const isSuspicious = (r: RepoRow): boolean => {
  const flagged = r.flags.reduce((n, f) => n + f.count, 0);
  return flagged >= SUSPICIOUS_MIN && r.total > 0 && flagged / r.total >= SUSPICIOUS_SHARE;
};

/** The share of a book's content lines that no link touches, when its coverage was counted. */
export const unlinkedShare = (r: RepoRow): number | null => (r.coverage && r.coverage.suitable > 0 ? r.coverage.unlinked / r.coverage.suitable : null);

export class RepositoryState {
  /** the source being analyzed (an open database); null = the first one */
  readonly sourceId = signal<string | null>(null);
  /** the counts of the books read so far, by book key */
  readonly rows = signal<ReadonlyMap<string, RepoRow>>(new Map());
  readonly progress = signal<RepoProgress | null>(null);
  /** when the last counting finished or was stopped (ms) */
  readonly analyzedAt = signal<number | null>(null);
  /** the books the user ticked, in the order ticked */
  readonly pickedBooks = signal<ReadonlySet<string>>(new Set());
  /** the pairs the user ticked, by "dependantKey>baseKey" */
  readonly pickedPairs = signal<ReadonlyMap<string, UserPair>>(new Map());
  readonly suggestions = signal<{ proposals: PairProposal[]; titled: number; unresolved: number } | null>(null);
  readonly suggesting = signal(false);
  /** the last error of a count the user asked for (a coverage count that failed); null when the last one did not fail */
  readonly error = signal<string | null>(null);
  /** the coverage of ONE book, counted for its details: it names the book, so another book's details never show it */
  readonly bookCoverage = signal<{ bookKey: string; summary: CoverageReport } | null>(null);
  /** the book whose details coverage is being counted */
  readonly bookCoverageBusy = signal<string | null>(null);
  private abort: AbortController | null = null;
  /** bumped when what a running count would write is no longer wanted (another source, rows dropped, reset): a plain stop keeps what was counted */
  private epoch = 0;
  private bookRun = 0;

  /** the open databases (a repository is a database, not text files) */
  readonly repositories = computed(() => this.host.sources.value.filter((s) => s.info.kind !== "text-files"));
  readonly source = computed<OpenedSource | null>(() => {
    const list = this.repositories.value;
    return list.find((s) => s.info.id === this.sourceId.value) ?? list[0] ?? null;
  });
  readonly books = computed<readonly SourceBook[]>(() => this.source.value?.books ?? []);

  readonly totals = computed<RepoTotals>(() => {
    const rows = this.rows.value;
    const byType = new Map<ConnectionType, number>();
    const flags = new Map<DbLinkFlag, { books: number; links: number }>();
    const t: RepoTotals = { books: this.books.value.length, counted: 0, links: 0, noLinks: 0, unavailable: 0, byType: [], ends: { same: 0, library: 0, other: 0, unresolved: 0 }, flags: [], flaggedBooks: 0, suspicious: 0 };
    for (const b of this.books.value) {
      const r = rows.get(b.key);
      if (!r) continue;
      t.counted++;
      if (r.unavailable) {
        t.unavailable++;
        continue;
      }
      t.links += r.out;
      if (r.total === 0) t.noLinks++;
      for (const [k, n] of Object.entries(r.typesOut)) byType.set(k as ConnectionType, (byType.get(k as ConnectionType) ?? 0) + n);
      for (const k of ["same", "library", "other", "unresolved"] as const) t.ends[k] += r.ends[k];
      if (r.flags.length) t.flaggedBooks++;
      for (const f of r.flags) {
        const cur = flags.get(f.flag) ?? { books: 0, links: 0 };
        flags.set(f.flag, { books: cur.books + 1, links: cur.links + f.count });
      }
      if (isSuspicious(r)) t.suspicious++;
    }
    t.byType = [...byType].sort((a, b) => b[1] - a[1]);
    t.flags = [...flags].map(([flag, v]) => ({ flag, ...v })).sort((a, b) => b.links - a.links);
    return t;
  });

  constructor(
    private readonly host: RepositoryHost,
    private readonly service: Pick<BooksService, "dbLinkSummary">,
  ) {}

  get available(): boolean {
    return !!this.service.dbLinkSummary;
  }

  get running(): boolean {
    return this.abort !== null;
  }

  chooseSource(id: string): void {
    if (this.sourceId.value === id) return;
    this.discard();
    this.sourceId.value = id;
    this.rows.value = new Map();
    this.analyzedAt.value = null;
    this.pickedBooks.value = new Set();
    this.pickedPairs.value = new Map();
    this.suggestions.value = null;
  }

  /** Stops the count; what it counted so far is kept. */
  cancel(): void {
    this.abort?.abort();
  }

  /** Stops the count AND what it would still write: its late end must not put old rows back (the source changed, the rows were dropped). */
  private discard(): void {
    this.epoch++;
    this.bookRun++;
    this.bookCoverage.value = null;
    this.bookCoverageBusy.value = null;
    this.error.value = null;
    this.abort?.abort();
  }

  /** Forgets the rows of books this database does not have (another database was opened since); true when something was dropped. */
  dropStale(): boolean {
    const keys = new Set(this.books.peek().map((b) => b.key));
    const rows = this.rows.peek();
    if (![...rows.keys()].some((k) => !keys.has(k))) return false;
    this.discard();
    this.rows.value = new Map([...rows].filter(([k]) => keys.has(k)));
    if (!this.rows.peek().size) this.analyzedAt.value = null;
    this.suggestions.value = null;
    this.pickedBooks.value = new Set([...this.pickedBooks.peek()].filter((k) => keys.has(k)));
    this.pickedPairs.value = new Map([...this.pickedPairs.peek()].filter(([, p]) => (!p.dependantKey || keys.has(p.dependantKey)) && (!p.baseKey || keys.has(p.baseKey))));
    return true;
  }

  /** Forgets everything counted (a changed database, or the user asks to start over). */
  reset(): void {
    this.discard();
    this.rows.value = new Map();
    this.analyzedAt.value = null;
    this.suggestions.value = null;
  }

  private rowOf(source: OpenedSource, book: SourceBook, s: DbLinkSummary | DbLinksUnavailable): RepoRow {
    const base = { key: book.key, title: book.title, ...(book.lineCount !== undefined && { lineCount: book.lineCount }) };
    // a book whose links were not all read (DbLinkSummary.unread) is not counted: its 0, or any count, would look like the whole
    const none = (unavailable: string): RepoRow => ({ ...base, total: 0, out: 0, in: 0, typesOut: {}, ends: { same: 0, library: 0, other: 0, unresolved: 0 }, flags: [], top: [], unavailable });
    if (!("total" in s)) return none(s.reason);
    if (s.unread) return none(s.unread);
    const typesOut: Partial<Record<ConnectionType, number>> = {};
    for (const t of s.byType) if (t.out) typesOut[t.type] = t.out;
    const ends = { same: 0, library: 0, other: 0, unresolved: 0 };
    for (const b of s.byBook) {
      if (!b.out) continue;
      if (b.bookKey.startsWith("unresolved:")) ends.unresolved += b.out;
      else if (sourceIdOfBookKey(b.bookKey) === source.info.id) ends.same += b.out;
      else if (this.host.isLibrarySource(sourceIdOfBookKey(b.bookKey))) ends.library += b.out;
      else ends.other += b.out;
    }
    return {
      ...base,
      total: s.total,
      out: s.out,
      in: s.in,
      typesOut,
      ends,
      flags: s.flags ? s.flags.map((f) => ({ flag: f.flag, count: f.count })) : [],
      top: s.byBook.slice(0, TOP).map((b) => ({ key: b.bookKey, title: b.title, links: b.out + b.in })),
    };
  }

  /**
   * Counts the links of the books, one at a time; the books already counted are kept (a second call continues), `again` starts over.
   * Resolves when every book was read or the work was stopped. The table is told of new rows every FLUSH_MS, not at every book.
   */
  async analyze(again = false): Promise<void> {
    const source = this.source.value;
    const read = this.service.dbLinkSummary;
    if (!source || !read || this.abort) return;
    if (again) this.rows.value = new Map();
    this.error.value = null;
    const ctl = (this.abort = new AbortController());
    const epoch = this.epoch;
    const todo = this.books.value.filter((b) => !this.rows.peek().has(b.key));
    const next = new Map(this.rows.peek());
    let last = performance.now();
    this.progress.value = { stage: "links", done: 0, total: todo.length };
    try {
      for (const [i, book] of todo.entries()) {
        if (ctl.signal.aborted) break;
        try {
          next.set(book.key, this.rowOf(source, book, await read.call(this.service, book.key, { signal: ctl.signal })));
        } catch (err) {
          if (ctl.signal.aborted) break;
          next.set(book.key, this.rowOf(source, book, { bookKey: book.key, reason: `קריאת הקישורים נכשלה: ${(err as Error).message ?? err}`, retry: true }));
        }
        if (performance.now() - last >= FLUSH_MS) {
          this.rows.value = new Map(next);
          this.progress.value = { stage: "links", done: i + 1, total: todo.length };
          last = performance.now();
        }
      }
    } finally {
      // a count that was only stopped keeps its rows; one that was discarded (another source, dropped rows) writes nothing
      if (epoch === this.epoch) {
        this.rows.value = new Map(next);
        this.analyzedAt.value = Date.now();
      }
      this.progress.value = null;
      this.abort = null;
    }
  }

  /** Counts the lines each of these books has linked (project and database links), one book at a time; stoppable. */
  async countCoverage(keys: readonly string[]): Promise<void> {
    if (this.abort) return;
    this.error.value = null;
    const ctl = (this.abort = new AbortController());
    const epoch = this.epoch;
    const next = new Map(this.rows.peek());
    const todo = keys.filter((k) => next.has(k) && !next.get(k)!.unavailable);
    let done = 0;
    let last = performance.now();
    this.progress.value = { stage: "coverage", done: 0, total: todo.length };
    try {
      for await (const row of this.host.coverage.rows(todo, { signal: ctl.signal })) {
        done = todo.indexOf(row.key) + 1;
        const cur = next.get(row.key);
        if (cur) next.set(row.key, withCoverage(cur, row));
        if (performance.now() - last >= FLUSH_MS) {
          this.rows.value = new Map(next);
          this.progress.value = { stage: "coverage", done, total: todo.length };
          last = performance.now();
        }
      }
    } catch (err) {
      // not thrown: the dialog starts this without waiting for it; the error is shown, and what was counted so far is kept
      if (!ctl.signal.aborted) this.error.value = `חישוב הכיסוי נכשל: ${(err as Error).message ?? err}`;
    } finally {
      if (epoch === this.epoch) this.rows.value = new Map(next);
      this.progress.value = null;
      this.abort = null;
    }
  }

  /**
   * The coverage of one book for its details (lines, ranges). The answer names its book and only the LAST asked book's answer is kept:
   * a slow count of book A that ends after the user moved to book B is dropped, not shown under B's heading. A failure sets `error`.
   */
  async countBookCoverage(bookKey: string): Promise<void> {
    const run = ++this.bookRun;
    this.error.value = null;
    this.bookCoverageBusy.value = bookKey;
    try {
      const summary = await this.host.coverage.summary(bookKey);
      if (run !== this.bookRun) return;
      if (summary) this.bookCoverage.value = { bookKey, summary };
      // null: the book is not open, or the user stopped the task. A stop is not an error.
      else if (!this.host.books?.value.has(bookKey)) this.error.value = "אי אפשר לחשב כיסוי: הספר לא פתוח, או שאורכו עדיין לא ידוע.";
    } catch (err) {
      if (run === this.bookRun) this.error.value = `חישוב הכיסוי נכשל: ${(err as Error).message ?? err}`;
    } finally {
      if (run === this.bookRun) this.bookCoverageBusy.value = null;
    }
  }

  /** The details of another book were opened (or closed): its coverage is not the one counted for the previous book. */
  leaveBook(): void {
    this.bookRun++;
    this.bookCoverage.value = null;
    this.bookCoverageBusy.value = null;
  }

  /** One book's links in full (by book and by type), for its detail; null when they cannot be read. */
  async detailOf(bookKey: string): Promise<DbLinkSummary | DbLinksUnavailable | null> {
    return this.service.dbLinkSummary ? this.service.dbLinkSummary(bookKey).catch(() => null) : null;
  }

  /* ---------------- picks ---------------- */

  togglePickedBook(key: string): void {
    const next = new Set(this.pickedBooks.value);
    if (!next.delete(key)) next.add(key);
    this.pickedBooks.value = next;
  }

  setPickedBooks(keys: Iterable<string>): void {
    this.pickedBooks.value = new Set(keys);
  }

  togglePickedPair(p: PairProposal): void {
    const k = `${p.dependant.key}>${p.base.key}`;
    const next = new Map(this.pickedPairs.value);
    if (!next.delete(k)) next.set(k, { dependant: p.dependant.title, base: p.base.title, dependantKey: p.dependant.key, baseKey: p.base.key, kind: p.kind });
    this.pickedPairs.value = next;
  }

  /** The books the guided flow is started with: the ticked books and the dependants of the ticked pairs. */
  chosenBooks(): string[] {
    return [...new Set([...this.pickedBooks.value, ...[...this.pickedPairs.value.values()].flatMap((p) => (p.dependantKey ? [p.dependantKey] : []))])];
  }

  /* ---------------- suggested pairs ---------------- */

  /**
   * Which book is written on which, by the evidence the books carry (linking/discovery.ts): the title, the links a book already has
   * to the base its title names, the length. It proposes with a confidence and the reasons; nothing runs and nothing is chosen.
   */
  async suggest(): Promise<void> {
    const source = this.source.value;
    if (!source || this.suggesting.value) return;
    this.suggesting.value = true;
    try {
      await new Promise((r) => setTimeout(r, 0)); // let "searching…" be seen before the (synchronous) title matching
      const rows = this.rows.peek();
      const books: DiscoveryBook[] = source.books.map((b) => {
        const r = rows.get(b.key);
        const lines = r?.coverage ? r.coverage.linked + r.coverage.partial + r.coverage.multiple : r && !r.unavailable && r.total === 0 ? 0 : undefined;
        return {
          key: b.key,
          title: b.title,
          origin: b.origin,
          ...(b.lineCount !== undefined && { lineCount: b.lineCount }),
          ...(r && r.top.length && { linkedTo: Object.fromEntries(r.top.map((t) => [t.title, t.links])), linkedKeys: Object.fromEntries(r.top.map((t) => [t.key, t.links])) }),
          ...(lines !== undefined && { linkedLines: lines }),
        };
      });
      const found = discoverPairs(books);
      this.suggestions.value = { proposals: found.proposals, titled: found.summary.titled, unresolved: found.summary.unresolved };
    } finally {
      this.suggesting.value = false;
    }
  }
}

/**
 * The row with its counted coverage, by what the read of the book's links said (CoverageRow.links): counted and none are a coverage (a
 * book with no links IS all unlinked); failed and unknown are not, and the row says that its coverage is unknown and why instead.
 */
function withCoverage(cur: RepoRow, row: CoverageRow): RepoRow {
  const { coverageUnknown: _u, coverageFailed: _f, ...rest } = cur;
  if (row.links.state === "failed" || row.links.state === "unknown") {
    const { coverage: _old, ...bare } = rest;
    return { ...bare, coverageUnknown: linksReadingText(row.links), ...(row.links.state === "failed" && { coverageFailed: true as const }) };
  }
  const c = row.counts.byBucket;
  return { ...rest, coverage: { suitable: row.counts.suitable, unlinked: row.counts.unlinked, linked: c.linked, partial: c.partial, multiple: c.multiple, notSuitable: c["not-suitable"], exact: row.exact, at: Date.now() } };
}
