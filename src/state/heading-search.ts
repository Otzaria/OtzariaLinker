import { signal, type ReadonlySignal } from "@preact/signals";
import type { BookHeading, SourceBook } from "../core/books";
import { sourceIdOfBookKey } from "../core/books";
import { normalize } from "../core/text/hebrew";
import type { BooksService, CallOptions, OpenedSource } from "./services";

/*
 * Searching the headings of many books at once (version 3's global heading index, F-139). Version 3 had two scopes:
 * "the open books" and "also the database books (heavy)". Here a database is an open source with thousands of books,
 * so the same two: "light" — every book of a files source, the books in the readers and the books the project links —
 * and "all", every open book, which reads the headings of a whole database and runs as a task with progress and
 * cancel. A book's headings are read once (a book's text does not change while it is open). The search is version
 * 3's: every word of the query must appear (in the heading or in the book's title), at most MAX_HITS results.
 */
export type HeadingScope = "light" | "all";
export const MAX_HITS = 300;

export interface HeadingHit {
  readonly key: string;
  readonly title: string;
  readonly line: number;
  readonly level: number;
  readonly text: string;
}

export interface HeadingSearchHost {
  readonly books: ReadonlySignal<Map<string, SourceBook>>;
  readonly sources: ReadonlySignal<readonly OpenedSource[]>;
  /** the keys of the books in the readers and of the books the project's links touch */
  inUse(): Iterable<string>;
  runTask<T>(label: string, run: (opts: CallOptions) => Promise<T>, count?: (done: number, total: number) => string): Promise<T | null>;
}

interface Indexed {
  readonly title: string;
  readonly heads: readonly (BookHeading & { readonly norm: string })[];
}

export class HeadingSearch {
  private readonly read = new Map<string, Indexed>();
  /** how much of the scope is read: the search says so when the answer may be partial */
  readonly status = signal<{ scope: HeadingScope; books: number; read: number; headings: number } | null>(null);

  constructor(
    private readonly host: HeadingSearchHost,
    private readonly service: Pick<BooksService, "headings">,
  ) {}

  /**
   * Forgets the headings read for the books `gone` names (a source closed, a book removed, the full reset): scope "all"
   * holds the headings of a whole database, which must not stay in memory after it closes (V7 round-2 review, finding 7).
   */
  forget(gone: (bookKey: string) => boolean): void {
    let changed = false;
    for (const k of [...this.read.keys()]) if (gone(k)) (this.read.delete(k), (changed = true));
    if (changed) this.status.value = null;
  }

  /** The books of a scope, by key: the light one never names a database book the user does not work on. */
  booksOf(scope: HeadingScope): string[] {
    const books = this.host.books.value;
    if (scope === "all") return [...books.keys()];
    const files = new Set(this.host.sources.value.filter((s) => s.info.kind === "text-files").map((s) => s.info.id));
    const keys = new Set<string>();
    for (const k of books.keys()) if (files.has(sourceIdOfBookKey(k))) keys.add(k);
    for (const k of this.host.inUse()) if (books.has(k)) keys.add(k);
    return [...keys];
  }

  /**
   * Reads the headings of the scope's books that were not read yet. False when it was cancelled or failed (what was
   * read stays: the next build goes on from there).
   */
  async build(scope: HeadingScope): Promise<boolean> {
    const keys = this.booksOf(scope);
    const todo = keys.filter((k) => !this.read.has(k));
    const done = !todo.length || (await this.host.runTask(
      "קורא את הכותרות של הספרים…",
      async (opts) => {
        let n = 0;
        for (const key of todo) {
          if (opts.signal?.aborted) return false;
          const book = this.host.books.peek().get(key);
          if (!book) continue;
          const hs = await this.service.headings(key, opts.signal ? { signal: opts.signal } : {});
          this.read.set(key, { title: book.title, heads: hs.map((h) => ({ ...h, norm: normalize(`${h.text}`) })) });
          opts.onProgress?.(++n, todo.length);
        }
        return true;
      },
      (d, t) => `${d.toLocaleString("he")} מתוך ${t.toLocaleString("he")} ספרים`,
    )) === true;
    const readNow = keys.filter((k) => this.read.has(k));
    this.status.value = { scope, books: keys.length, read: readNow.length, headings: readNow.reduce((n, k) => n + this.read.get(k)!.heads.length, 0) };
    return done;
  }

  /**
   * Every word of the query in the heading or in the book's title (nikud and quote marks ignored), among the books
   * of the scope that were read; the books in their order, the headings in the book's order. At most `limit`.
   */
  search(query: string, scope: HeadingScope, limit = MAX_HITS): { hits: HeadingHit[]; more: boolean } {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    if (!words.length) return { hits: [], more: false };
    const hits: HeadingHit[] = [];
    for (const key of this.booksOf(scope)) {
      const b = this.read.get(key);
      if (!b) continue;
      const title = normalize(b.title);
      for (const h of b.heads) {
        if (!words.every((w) => h.norm.includes(w) || title.includes(w))) continue;
        if (hits.length === limit) return { hits, more: true };
        hits.push({ key, title: b.title, line: h.line, level: h.level, text: h.text });
      }
    }
    return { hits, more: false };
  }
}
