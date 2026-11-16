import { signal } from "@preact/signals";
import type { SourceLine } from "../core/books";
import type { Link } from "../core/links/model";
import type { BooksService } from "./services";

/*
 * Lines and existing database links are fetched from the worker in fixed chunks and kept in a
 * bounded cache (stage 3.4/18: lazy loading, bounded cache with eviction, no repeated work).
 * `tick` changes whenever a chunk arrives, so views re-read what they show.
 */
export const CHUNK = 200;
const MAX_CHUNKS = 400; // ~80k lines across all books
/** a chunk that failed is read again when a view asks for it after this long (review C8) */
export const RETRY_MS = 5000;

type ChunkState<T> = { status: "loading"; promise: Promise<void> } | { status: "ready"; items: T[] } | { status: "error"; message: string; at: number };

class ChunkCache<T> {
  private readonly chunks = new Map<string, ChunkState<T>>();
  constructor(
    private readonly fetch: (bookKey: string, from: number, to: number) => Promise<T[]>,
    private readonly onChange: () => void,
  ) {}

  state(bookKey: string, chunk: number): ChunkState<T> | undefined {
    return this.chunks.get(`${bookKey}#${chunk}`);
  }

  /** Marks a chunk most recently used (a view showed it), so the eviction takes older ones first. */
  touch(bookKey: string, chunk: number): void {
    const key = `${bookKey}#${chunk}`;
    const s = this.chunks.get(key);
    if (s?.status !== "ready" || this.chunks.size < MAX_CHUNKS / 2) return;
    this.chunks.delete(key);
    this.chunks.set(key, s);
  }

  ensure(bookKey: string, chunk: number): Promise<void> {
    const key = `${bookKey}#${chunk}`;
    const hit = this.chunks.get(key);
    if (hit?.status === "ready") return Promise.resolve();
    if (hit?.status === "loading") return hit.promise;
    const loading: ChunkState<T> = {
      status: "loading",
      promise: this.fetch(bookKey, chunk * CHUNK, chunk * CHUNK + CHUNK - 1).then(
        (items) => this.settle(key, loading, { status: "ready", items }),
        (err: Error) => this.settle(key, loading, { status: "error", message: err.message, at: Date.now() }),
      ),
    };
    this.chunks.set(key, loading);
    return loading.promise;
  }

  drop(bookKeyPrefix: string): void {
    for (const k of [...this.chunks.keys()]) if (k.startsWith(bookKeyPrefix)) this.chunks.delete(k);
    this.onChange();
  }

  /**
   * A fetch is over. It is recorded only if its chunk is still the one it was started for: a drop
   * (the source closed, the worker restarted) or a newer load replaced it, and a late answer must not
   * bring back what was forgotten (review C8).
   */
  private settle(key: string, loading: ChunkState<T>, s: ChunkState<T>): void {
    if (this.chunks.get(key) !== loading) return;
    this.chunks.delete(key); // re-insert = most recently used
    this.chunks.set(key, s);
    while (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value!);
    this.onChange();
  }
}

/** Whether a view should (re)load a chunk: never asked, or it failed long enough ago to try again. */
const wanted = (s: ChunkState<unknown> | undefined): boolean => !s || (s.status === "error" && Date.now() - s.at >= RETRY_MS);

/**
 * The line count of a book shorter than `below` lines, when it does not say (text files): a binary
 * search for the last chunk-wide window that still has a line (a database may skip line numbers, so a
 * window of CHUNK lines is probed, not a single line). About log2(below / CHUNK) small reads.
 */
async function lastLineAfter(service: Pick<BooksService, "lines">, bookKey: string, below: number): Promise<number> {
  let lo = 0; // a window starting at lo has a line, or lo === 0
  let hi = below; // no line at or after hi
  let last = 0;
  while (hi - lo > CHUNK) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const got = await service.lines(bookKey, mid, mid + CHUNK - 1);
    if (got.length) (lo = mid), (last = got.at(-1)!.index + 1);
    else hi = mid;
  }
  const got = await service.lines(bookKey, lo, hi - 1);
  return got.length ? got.at(-1)!.index + 1 : last;
}

export class LineStore {
  readonly tick = signal(0);
  /** line counts learned from a short last chunk — text books do not know their length up front */
  private readonly counts = new Map<string, number>();
  private readonly lines: ChunkCache<SourceLine>;
  private readonly existing: ChunkCache<Link>;

  constructor(service: BooksService) {
    const bump = () => (this.tick.value = this.tick.peek() + 1);
    this.lines = new ChunkCache(async (b, f, t) => {
      const got = await service.lines(b, f, t);
      // Place every line by its OWN index: a database may skip line numbers (the generator creates
      // no row for an empty heading), so position-in-chunk is not the line number (compat review #6).
      // A missing index stays a hole (undefined), which views show as "line not in the book".
      const placed: SourceLine[] = [];
      for (const l of got) placed[l.index - f] = l;
      if (got.length < t - f + 1 && (!got.length || got.at(-1)!.index < t)) {
        // a short chunk ends the book; an EMPTY one past the end only says the book is shorter than
        // `f`, so the end is searched for (a link to line 999 of a 12-line book must not make it an
        // 800-line book of empty lines: product audit F6)
        const count = got.length ? got.at(-1)!.index + 1 : await lastLineAfter(service, b, f);
        this.counts.set(b, count);
      }
      return placed;
    }, bump);
    this.existing = new ChunkCache((b, f, t) => service.existingLinks(b, f, t), bump);
  }

  /** The line if loaded; starts loading its chunk otherwise. Reading `tick` first subscribes a view. */
  line(bookKey: string, index: number): SourceLine | undefined {
    const c = Math.floor(index / CHUNK);
    const s = this.lines.state(bookKey, c);
    if (wanted(s)) void this.lines.ensure(bookKey, c);
    else if (s!.status === "ready") this.lines.touch(bookKey, c);
    return s?.status === "ready" ? s.items[index - c * CHUNK] : undefined;
  }

  /** Number of lines, once the end of the book has been read (undefined before). */
  count(bookKey: string): number | undefined {
    return this.counts.get(bookKey);
  }

  /** Error message of the chunk holding `index`, if loading it failed. */
  errorAt(bookKey: string, index: number): string | null {
    const s = this.lines.state(bookKey, Math.floor(index / CHUNK));
    return s?.status === "error" ? s.message : null;
  }

  peek(bookKey: string, index: number): SourceLine | undefined {
    const c = Math.floor(index / CHUNK);
    const s = this.lines.state(bookKey, c);
    return s?.status === "ready" ? s.items[index - c * CHUNK] : undefined;
  }

  async load(bookKey: string, from: number, to: number): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (let c = Math.floor(from / CHUNK); c <= Math.floor(to / CHUNK); c++) jobs.push(this.lines.ensure(bookKey, c));
    await Promise.all(jobs);
  }

  /** Existing database links whose stored source or target lies in the chunk of `index`. */
  existingAt(bookKey: string, index: number): Link[] | undefined {
    const c = Math.floor(index / CHUNK);
    const s = this.existing.state(bookKey, c);
    if (wanted(s)) void this.existing.ensure(bookKey, c);
    else if (s!.status === "ready") this.existing.touch(bookKey, c);
    return s?.status === "ready" ? s.items : undefined;
  }

  /** Loads the existing database links of the chunks holding lines [from, to] (errors: nothing to compare). */
  async loadExisting(bookKey: string, from: number, to: number): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (let c = Math.floor(from / CHUNK); c <= Math.floor(to / CHUNK); c++) jobs.push(this.existing.ensure(bookKey, c));
    await Promise.all(jobs);
  }

  /**
   * The existing database links of the chunk holding `index`, if loaded — without starting a load
   * (for validation inside computeds). The array is the same object until the chunk is reloaded.
   */
  existingPeek(bookKey: string, index: number): Link[] | undefined {
    const s = this.existing.state(bookKey, Math.floor(index / CHUNK));
    return s?.status === "ready" ? s.items : undefined;
  }

  forgetAll(): void {
    this.counts.clear();
    this.lines.drop("");
    this.existing.drop("");
  }

  forgetSource(sourceId: string): void {
    this.lines.drop(`${sourceId}:`);
    this.existing.drop(`${sourceId}:`);
  }
}
