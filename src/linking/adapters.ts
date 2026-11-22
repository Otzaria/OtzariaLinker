import type { SourceBook, SourceLine } from "../core/books";
import type { BookRef, Link } from "../core/links/model";
import { runEngineSliced, type EngineBook, type EngineContext, type EngineId, type EngineResult } from "./automatic";

/*
 * The seam between the linking engines and whoever hosts them (issue 9, plugin readiness). The engines are pure
 * functions over in-memory lines; everything they need from the world — the books and their lines, the headings, the
 * links the host already has, resolving a reference, searching text, saving what was made, progress and cancel — is
 * listed here as small ports, in terms of `core` types only. A host (the single-file app through its worker, a test, a
 * future Otzaria plugin that reads books through Otzaria's own API) implements the ports it has and calls `runPair`.
 *
 * Layering: this file imports `core` and the engines only (so it is allowed to `linking`, and runs in Node with no
 * DOM, no Preact and no database reader — tests/unit/architecture.test.ts "the headless surface" holds that line).
 * It does NOT replace `state/services.ts` BooksService, which is the app's own, richer interface (sources, mapping,
 * Worker RPC); a plugin that wants the whole `state` layer implements BooksService instead (docs/PLUGIN_READINESS.md).
 *
 * Read-only on the host's data: no port writes books or links into the host's library (AGENTS.md 2.3). `SavePort`
 * receives files the tool made (a `_links.json`), for the host to hand to the user.
 */

/** The books a host can read, and their lines. Lines are 0-based, `to` inclusive, like `SourceBook`/`SourceLine`. */
export interface BooksPort {
  list(): Promise<readonly SourceBook[]>;
  lines(bookKey: string, from: number, to: number, signal?: AbortSignal): Promise<readonly SourceLine[]>;
  /** 0-based indexes of the lines the generator treats as headings (links to them are dropped) */
  headings(bookKey: string): Promise<readonly number[]>;
}

/** The links the host already has for a book (so a suggestion that exists is marked "exists"). Read-only. */
export interface LinksPort {
  existing(bookKey: string, signal?: AbortSignal): Promise<readonly Link[]>;
}

/** Turning a reference into a place, in the host's own books ("בראשית א, ב" → book + line); null when it cannot. */
export interface RefPort {
  resolve(ref: string, signal?: AbortSignal): Promise<{ readonly bookKey: string; readonly line: number } | null>;
}

/** Text search in one book (the engines do not need it; reviewers do: "show me where this is mentioned"). */
export interface SearchPort {
  find(bookKey: string, query: string, signal?: AbortSignal): Promise<readonly { readonly line: number }[]>;
}

/** Where a made file goes (the app: a download; a plugin: its private files or a save dialog). */
export interface SavePort {
  save(file: { readonly name: string; readonly mimeType: string; readonly content: string | Uint8Array }): Promise<void>;
}

export interface LinkerAdapters {
  readonly books: BooksPort;
  readonly links?: LinksPort;
  readonly refs?: RefPort;
  readonly search?: SearchPort;
  readonly save?: SavePort;
  /** progress in the engine's own units (done/total), called now and then */
  readonly progress?: (done: number, total: number) => void;
  /** cancel: an aborted signal stops the engine at its next line (the engines are cooperative) */
  readonly cancel?: AbortSignal;
}

/** How many lines a host is asked for at a time (a plugin's host API may cap a read; the app's worker reads a whole book). */
export const LINES_PER_READ = 200;

/**
 * Reads a whole book through the port into what an engine takes. `text` is the line as the generator counts anchor
 * offsets (`anchorText`: schema 7 puts the footnote bodies in it), exactly as the worker's engine job does.
 */
export async function loadEngineBook(books: BooksPort, book: BookRef, signal?: AbortSignal, perRead = LINES_PER_READ): Promise<EngineBook> {
  const lines: EngineBook["lines"][number][] = [];
  for (let from = 0; ; from += perRead) {
    signal?.throwIfAborted();
    const got = await books.lines(book.key, from, from + perRead - 1, signal);
    for (const l of got) lines.push({ index: l.index, text: l.anchorText, heading: l.heading, heRef: l.heRef });
    if (got.length < perRead) break;
  }
  return { book, lines };
}

/** Runs one pair engine over two books of the host: the headless counterpart of the worker's `engineJob`. */
export async function runPair(a: LinkerAdapters, engine: EngineId, source: BookRef, target: BookRef, options: Record<string, unknown> = {}): Promise<EngineResult> {
  const s = await loadEngineBook(a.books, source, a.cancel);
  const t = await loadEngineBook(a.books, target, a.cancel);
  a.cancel?.throwIfAborted();
  const ctx: EngineContext = { ...(a.cancel && { signal: a.cancel }), ...(a.progress && { progress: a.progress }) };
  return runEngineSliced(engine, s, t, options, ctx);
}
