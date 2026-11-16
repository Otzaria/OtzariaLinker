import { computed, signal } from "@preact/signals";
import { foldQuery, MIN_QUERY, type BookHit, type BookSearchResult } from "../core/text/find";
import type { BooksService } from "./services";

/*
 * The search box of one reader (v3 §6.5 "חיפוש בתוך פאנל"): a query, the worker's capped list of
 * hits, and the current hit. A new query cancels the search still running; moving between hits
 * asks the reader to scroll to the line (reveal), which also flashes it.
 */
export type FindStatus = "idle" | "searching" | "done" | "error";

export class BookFind {
  readonly open = signal(false);
  readonly query = signal("");
  /** the book the result belongs to */
  readonly bookKey = signal<string | null>(null);
  readonly result = signal<BookSearchResult | null>(null);
  readonly status = signal<FindStatus>("idle");
  readonly error = signal<string | null>(null);
  readonly progress = signal<{ done: number; total: number } | null>(null);
  /** index into result.hits of the current hit, -1 for none */
  readonly pos = signal(-1);

  readonly hitLines = computed<ReadonlySet<number>>(() => new Set(this.result.value?.hits.map((h) => h.line)));
  readonly current = computed<BookHit | null>(() => this.result.value?.hits[this.pos.value] ?? null);

  private ac: AbortController | null = null;

  constructor(
    private readonly service: Pick<BooksService, "searchBook">,
    private readonly reveal: (bookKey: string, line: number) => void,
  ) {}

  /** Searches a book; resolves when this search is done, replaced or cancelled. */
  async search(bookKey: string, query: string): Promise<void> {
    this.ac?.abort();
    this.ac = null;
    this.query.value = query;
    this.bookKey.value = bookKey;
    this.error.value = null;
    this.progress.value = null;
    if (foldQuery(query).length < MIN_QUERY) {
      this.result.value = null;
      this.pos.value = -1;
      this.status.value = "idle";
      return;
    }
    const ac = new AbortController();
    this.ac = ac;
    this.status.value = "searching";
    try {
      const r = await this.service.searchBook(bookKey, query, {}, { signal: ac.signal, onProgress: (done, total) => this.ac === ac && (this.progress.value = { done, total }) });
      if (this.ac !== ac) return;
      this.result.value = r;
      this.status.value = "done";
      this.pos.value = r.hits.length ? 0 : -1;
      if (r.hits.length) this.reveal(bookKey, r.hits[0]!.line);
    } catch (err) {
      if (this.ac !== ac || ac.signal.aborted) return;
      this.result.value = null;
      this.pos.value = -1;
      this.status.value = "error";
      this.error.value = (err as { message?: string }).message ?? String(err);
    } finally {
      if (this.ac === ac) {
        this.ac = null;
        this.progress.value = null;
      }
    }
  }

  /** Next (+1) or previous (-1) hit, wrapping around. */
  step(delta: number): void {
    const n = this.result.value?.hits.length ?? 0;
    if (!n) return;
    const at = this.pos.value < 0 ? (delta > 0 ? 0 : n - 1) : (((this.pos.value + delta) % n) + n) % n;
    this.goTo(at);
  }

  goTo(index: number): void {
    const hit = this.result.value?.hits[index];
    const key = this.bookKey.value;
    if (!hit || !key) return;
    this.pos.value = index;
    this.reveal(key, hit.line);
  }

  /** Stops a running search. */
  cancel(): void {
    if (!this.ac) return;
    this.ac.abort();
    this.ac = null;
    this.status.value = "idle";
    this.progress.value = null;
  }

  /** Closes the box and forgets the query and its hits. */
  close(): void {
    this.cancel();
    this.open.value = false;
    this.query.value = "";
    this.result.value = null;
    this.pos.value = -1;
    this.status.value = "idle";
    this.error.value = null;
  }
}
