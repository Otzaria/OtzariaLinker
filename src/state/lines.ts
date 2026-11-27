import { signal } from "@preact/signals";
import type { SourceLine } from "../core/books";
import { linkMatchIndex, matchIndexOf, type LinkMatchIndex } from "../core/links/equality";
import type { Link } from "../core/links/model";
import type { LineFacts } from "../core/links/validate";
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
  /**
   * The chunks a check read (LineStore.beginCheck), kept out of the eviction until the next check or
   * until their source goes: a check of more chunks than MAX_CHUNKS must not lose the first ones
   * before it reads them (review C7). Null when no check kept anything.
   */
  private kept: Map<string, T[]> | null = null;
  constructor(
    private readonly fetch: (bookKey: string, from: number, to: number) => Promise<T[]>,
    private readonly onChange: () => void,
  ) {}

  state(bookKey: string, chunk: number): ChunkState<T> | undefined {
    const key = `${bookKey}#${chunk}`;
    const s = this.chunks.get(key);
    if (s || !this.kept) return s;
    const items = this.kept.get(key);
    return items && { status: "ready", items };
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
    if (hit?.status === "ready") return (this.kept?.set(key, hit.items), Promise.resolve());
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

  /** Starts a check's snapshot: what ensure() reads from now on is kept until the next one (see `kept`). */
  beginKeep(): void {
    this.kept = new Map();
  }

  drop(bookKeyPrefix: string): void {
    for (const k of [...this.chunks.keys()]) if (k.startsWith(bookKeyPrefix)) this.chunks.delete(k);
    if (this.kept) for (const k of [...this.kept.keys()]) if (k.startsWith(bookKeyPrefix)) this.kept.delete(k);
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
    if (s.status === "ready") this.kept?.set(key, s.items);
    while (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value!);
    this.onChange();
  }
}

/** Whether a view should (re)load a chunk: never asked, or it failed long enough ago to try again. */
const wanted = (s: ChunkState<unknown> | undefined): boolean => !s || (s.status === "error" && Date.now() - s.at >= RETRY_MS);

/** What the rules (core/links/validate.ts) need of a line. */
export function lineFacts(l: SourceLine): LineFacts {
  return { exists: l.existsInDb, heading: l.heading, anchorLength: l.anchorText.length, hasNotes: l.anchorText !== l.text || l.text.includes('class="footnote"') };
}

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
  /**
   * The facts of the lines a check read (loadFacts), by book and line — never evicted, so the export
   * and the quality check judge every link on its real line however many chunks they read (review C7).
   * Small: four fields per link end, forgotten with the source.
   */
  private readonly facts = new Map<string, Map<number, LineFacts>>();

  constructor(private readonly service: BooksService) {
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

  /** the end searches running, by book: one at a time */
  private readonly learning = new Map<string, Promise<number | undefined>>();

  /**
   * Learns the number of lines of a book that does not say it up front (a text book) without reading it
   * all into the views: a few one-line reads double until one is past the end, then the end is searched
   * (lastLineAfter). For a saved project's check that a book did not change (V5 P1-10). Undefined on failure.
   */
  learnCount(bookKey: string): Promise<number | undefined> {
    const known = this.counts.get(bookKey);
    if (known !== undefined) return Promise.resolve(known);
    let run = this.learning.get(bookKey);
    if (!run) {
      run = (async () => {
        let hi = CHUNK;
        while ((await this.service.lines(bookKey, hi, hi)).length) hi *= 2;
        const n = await lastLineAfter(this.service, bookKey, hi);
        this.counts.set(bookKey, n);
        this.tick.value = this.tick.peek() + 1;
        return n;
      })().catch(() => undefined);
      this.learning.set(bookKey, run);
      void run.then(() => this.learning.delete(bookKey));
    }
    return run;
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

  /**
   * Starts a check (the export, the quality check): the existing database links it loads from now on
   * stay readable through existingPeek until the next check, whatever the views load meanwhile.
   */
  beginCheck(): void {
    this.existing.beginKeep();
  }

  /** Loads the given lines of a book chunk by chunk and keeps their facts for factsAt (see `facts`). */
  async loadFacts(bookKey: string, indexes: Iterable<number>, opts: { signal?: AbortSignal | undefined; onChunk?: () => void } = {}): Promise<void> {
    const byChunk = new Map<number, number[]>();
    for (const i of indexes) {
      const c = Math.floor(i / CHUNK);
      const list = byChunk.get(c);
      if (list) list.push(i);
      else byChunk.set(c, [i]);
    }
    let book = this.facts.get(bookKey);
    if (!book) this.facts.set(bookKey, (book = new Map()));
    for (const [c, list] of byChunk) {
      opts.signal?.throwIfAborted();
      await this.lines.ensure(bookKey, c);
      opts.onChunk?.();
      // read at once: the chunk was just loaded (or found), and nothing ran in between to evict it
      const s = this.lines.state(bookKey, c);
      if (s?.status !== "ready") continue; // a failed chunk: its lines stay "not verified"
      let refs = this.heRefs.get(bookKey);
      for (const i of list) {
        const l = s.items[i - c * CHUNK];
        if (!l) continue;
        book.set(i, lineFacts(l));
        if (l.heRef) (refs ??= this.heRefs.set(bookKey, new Map()).get(bookKey)!).set(i, l.heRef);
      }
    }
  }

  /**
   * The heRef of each line a check read (loadFacts), kept like the facts: the export fills a link's Sefaria ref from it after the
   * check has read every line, and the views' cache has dropped the first chunks by then (V7 §4.10: 44,453 of 44,975 links of a
   * v52 run were held back for a missing ref_2 their lines' heRefs gave).
   */
  private readonly heRefs = new Map<string, Map<number, string>>();

  /** A line's heRef: from the cache, else as the last check read it; undefined when never read (or it has none). */
  heRefAt(bookKey: string, index: number): string | null | undefined {
    const l = this.peek(bookKey, index);
    return l ? l.heRef : this.heRefs.get(bookKey)?.get(index);
  }

  /** The facts of a line: from the cache, else as the last check read them; undefined when never read. */
  factsAt(bookKey: string, index: number): LineFacts | undefined {
    const l = this.peek(bookKey, index);
    return l ? lineFacts(l) : this.facts.get(bookKey)?.get(index);
  }

  /**
   * What the database has at the very lines the checks needed (loadExistingLines), by book and line: the match index of the links
   * read there (core/links/equality.ts), not the links themselves. "Already in the database" is decided by the links on a project
   * link's own lines (the start lines), and a chunk of a heavily linked book holds tens of thousands of them: reading whole chunks
   * made the check of 249 links on seforim.db take 8-9 minutes (V7 §4.9, docs/reviews/V7_PERFORMANCE.md §9). A database open in the
   * tool never changes, so what was read is kept for the next check (QA and then the export read the same lines) until its source
   * is closed or the worker is replaced.
   */
  private readonly existingLines = new Map<string, Map<number, LinkMatchIndex>>();

  /**
   * Reads the database links at those of these lines that were not read yet, one call per run of consecutive lines; each line of a
   * run gets the run's index (a superset, which the identity match does not mind). A read that fails leaves its lines without
   * (nothing to compare, as a failed chunk), to be tried again by the next check.
   */
  async loadExistingLines(bookKey: string, indexes: Iterable<number>, signal?: AbortSignal): Promise<void> {
    let book = this.existingLines.get(bookKey);
    if (!book) this.existingLines.set(bookKey, (book = new Map()));
    const known = book;
    const sorted = [...new Set(indexes)].filter((i) => !known.has(i)).sort((a, b) => a - b);
    const runs: [number, number][] = [];
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
      runs.push([sorted[i]!, sorted[j]!]);
      i = j + 1;
    }
    const keep = (run: readonly [number, number], ix: LinkMatchIndex) => {
      for (let k = run[0]; k <= run[1]; k++) book.set(k, ix);
    };
    // every run of the book in one call that sends back only the identities (V7 round 2 item 11, V7_PERFORMANCE.md §10); a service
    // without it, or a batch that failed, reads run by run as before
    let batched = false;
    if (runs.length && this.service.existingMatchIndexes) {
      signal?.throwIfAborted();
      try {
        const got = await this.service.existingMatchIndexes(bookKey, runs, signal ? { signal } : undefined);
        if (got.length === runs.length) {
          runs.forEach((run, r) => keep(run, matchIndexOf(got[r]!)));
          batched = true;
        }
      } catch {
        signal?.throwIfAborted();
      }
    }
    if (!batched)
      for (const run of runs) {
        signal?.throwIfAborted();
        try {
          keep(run, linkMatchIndex(await this.service.existingLinks(bookKey, run[0], run[1])));
        } catch {
          /* not compared, like a chunk that failed */
        }
      }
    if (sorted.length) this.tick.value = this.tick.peek() + 1;
  }

  /** The match index of the database links read at a line by a check (loadExistingLines); undefined when none read it. */
  existingIndexAt(bookKey: string, index: number): LinkMatchIndex | undefined {
    return this.existingLines.get(bookKey)?.get(index);
  }

  forgetAll(): void {
    this.counts.clear();
    this.facts.clear();
    this.heRefs.clear();
    this.existingLines.clear();
    this.lines.drop("");
    this.existing.drop("");
  }

  forgetSource(sourceId: string): void {
    for (const k of [...this.facts.keys()]) if (k.startsWith(`${sourceId}:`)) this.facts.delete(k);
    for (const k of [...this.heRefs.keys()]) if (k.startsWith(`${sourceId}:`)) this.heRefs.delete(k);
    for (const k of [...this.existingLines.keys()]) if (k.startsWith(`${sourceId}:`)) this.existingLines.delete(k);
    this.lines.drop(`${sourceId}:`);
    this.existing.drop(`${sourceId}:`);
  }
}
