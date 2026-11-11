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

type ChunkState<T> = { status: "loading"; promise: Promise<void> } | { status: "ready"; items: T[] } | { status: "error"; message: string };

class ChunkCache<T> {
  private readonly chunks = new Map<string, ChunkState<T>>();
  constructor(
    private readonly fetch: (bookKey: string, from: number, to: number) => Promise<T[]>,
    private readonly onChange: () => void,
  ) {}

  state(bookKey: string, chunk: number): ChunkState<T> | undefined {
    return this.chunks.get(`${bookKey}#${chunk}`);
  }

  ensure(bookKey: string, chunk: number): Promise<void> {
    const key = `${bookKey}#${chunk}`;
    const hit = this.chunks.get(key);
    if (hit?.status === "ready") return Promise.resolve();
    if (hit?.status === "loading") return hit.promise;
    const promise = this.fetch(bookKey, chunk * CHUNK, chunk * CHUNK + CHUNK - 1).then(
      (items) => void this.put(key, { status: "ready", items }),
      (err: Error) => void this.put(key, { status: "error", message: err.message }),
    );
    this.chunks.set(key, { status: "loading", promise });
    return promise;
  }

  drop(bookKeyPrefix: string): void {
    for (const k of [...this.chunks.keys()]) if (k.startsWith(bookKeyPrefix)) this.chunks.delete(k);
    this.onChange();
  }

  private put(key: string, s: ChunkState<T>): void {
    this.chunks.delete(key); // re-insert = most recently used
    this.chunks.set(key, s);
    while (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value!);
    this.onChange();
  }
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
      if (got.length < t - f + 1 && (!got.length || got.at(-1)!.index < t)) this.counts.set(b, got.length ? got.at(-1)!.index + 1 : f);
      return placed;
    }, bump);
    this.existing = new ChunkCache((b, f, t) => service.existingLinks(b, f, t), bump);
  }

  /** The line if loaded; starts loading its chunk otherwise. Reading `tick` first subscribes a view. */
  line(bookKey: string, index: number): SourceLine | undefined {
    const c = Math.floor(index / CHUNK);
    const s = this.lines.state(bookKey, c);
    if (!s) void this.lines.ensure(bookKey, c);
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
    if (!s) void this.existing.ensure(bookKey, c);
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
