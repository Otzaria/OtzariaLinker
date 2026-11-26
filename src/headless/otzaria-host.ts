import type { SourceBook, SourceLine } from "../core/books";
import { LinkerError } from "../core/errors";
import type { BookRef, Link } from "../core/links/model";
import { headingLevel, stripTags } from "../core/text/html";
import { recordToLink } from "../formats/links-json/convert";
import { parseLinksJson } from "../formats/links-json/parse";
import type { BooksPort, LinkerAdapters, LinksPort, SavePort, SearchPort } from "../linking/adapters";

/*
 * The ports of linking/adapters.ts over Otzaria's plugin API (`Otzaria.call`, SDK 1.x; Otzaria/otzaria docs/plugin-sdk,
 * README "Host API" and API_REFERENCE, read at a6be90800, 2026-11-22). Pure: the host function is passed in, so the same
 * code runs inside a plugin (window.Otzaria.call), in a Node test against a simulated host (tests/support/otzaria-sim.ts)
 * and nowhere touches a browser global (tests/unit/architecture.test.ts, "the headless surface").
 *
 * What each port uses, and the SDK limit it keeps:
 *   books   library.getBookMetadata (the title), library.getBookContent (at most 5,000 characters a call, rawDivineNames: true —
 *           the stored text, so anchor offsets are the generator's and not the user's display of the divine names)
 *   links   library.getRawLinks (a window of at most 1,000 lines; a truncated answer is read again in a smaller window,
 *           as the SDK says: `endLine` is a valid continuation only when `truncated` is false)
 *   search  search.fullText (results of the book asked for only)
 *   save    fs.writeFile in the plugin's private space (at most 10 MB a call): NEVER the library — library books are read-only
 *   calls   error.rate_limited is retried after a pause (a 50-token bucket refilled every 10 ms; getBookContent is exempt only
 *           when library.content.read was actually granted)
 *
 * NOT verified against a running Otzaria (docs/PLUGIN_READINESS.md §3): that getBookContent's text is the book's lines joined by
 * "\n" (the app's getBookText), so a line here is a line_index of the links; schema 7 footnote bodies are not in it, so the anchor
 * text of a line with notes is shorter than the generator's (the footnotes engine and anchors on such lines are not reliable here);
 * there is no heRef per line in the API that was read (heRef is null: the engines fall back to the headings).
 */

export interface OtzariaResponse<T = unknown> {
  success: boolean;
  data: T | null;
  error: { code: string; message?: string } | null;
}

/** `Otzaria.call` as the SDK injects it (README "ה-SDK"). */
export type OtzariaCall = (method: string, payload?: Record<string, unknown>) => Promise<OtzariaResponse>;

/** SDK limits the adapter keeps (README "Host API", "אבטחה ומגבלות"; API_REFERENCE getBookContent, getRawLinks, fs). */
export const SDK_LIMITS = {
  /** library.getBookContent: characters per call */
  contentChars: 5000,
  /** library.getRawLinks: lines per window */
  rawLinksWindow: 1000,
  /** fs.writeFile: bytes per call */
  writeBytes: 10 * 1024 * 1024,
  /** fs: the plugin's private quota */
  quotaBytes: 100 * 1024 * 1024,
  /** the rate limiter's bucket and refill (one call each) */
  bucket: 50,
  refillMs: 10,
  /** Otzaria.call's default timeout */
  timeoutMs: 30_000,
} as const;

export interface OtzariaHostOptions {
  /** the books the host works on, by Otzaria's bookId (a plugin gets them from library.findBooks or the reader) */
  books: readonly string[];
  /** the folder in the plugin's private space that saved files go to */
  saveDir?: string;
  /** pause between retries of a rate-limited call (a test passes a fake clock) */
  sleep?: (ms: number) => Promise<void>;
  /** how many times a rate-limited call is tried again before it fails */
  retries?: number;
  /** books whose text is kept in memory at once (each is read whole: the engines need the whole book) */
  cachedBooks?: number;
}

const KEY_PREFIX = "otz:";
export const otzariaBookKey = (bookId: string): string => `${KEY_PREFIX}${bookId}`;
const bookIdOf = (key: string): string => {
  if (!key.startsWith(KEY_PREFIX)) throw new LinkerError("plugin/unknown-book", `הספר "${key}" אינו ספר של אוצריא בתוסף הזה. בחרו ספר מהספרייה.`);
  return key.slice(KEY_PREFIX.length);
};

/** One call, its error said in Hebrew; a rate-limited call is tried again after a pause (the bucket refills every 10 ms). */
export async function callHost<T>(call: OtzariaCall, method: string, payload: Record<string, unknown>, opts: Pick<OtzariaHostOptions, "sleep" | "retries"> = {}): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = opts.retries ?? 20;
  for (let attempt = 0; ; attempt++) {
    const res = await call(method, payload);
    if (res.success) return res.data as T;
    const code = res.error?.code ?? "error.unknown";
    if (code === "error.rate_limited" && attempt < retries) {
      // a few tokens' worth, growing: a burst that emptied the bucket waits for it to refill a little
      await sleep(SDK_LIMITS.refillMs * Math.min(SDK_LIMITS.bucket, 2 ** attempt));
      continue;
    }
    throw new LinkerError("plugin/host-error", hostErrorText(method, code), { method, code, ...(res.error?.message && { message: res.error.message }) });
  }
}

function hostErrorText(method: string, code: string): string {
  if (code === "error.permission_denied") return `אוצריא סירבה לפעולה ${method}: לתוסף אין את ההרשאה שהיא דורשת. אשרו את ההרשאה בהגדרות התוספים ונסו שוב.`;
  if (code === "error.rate_limited") return `אוצריא הגבילה את קצב הקריאות (${method}) גם אחרי המתנה. נסו שוב בעוד רגע.`;
  if (code === "error.timeout") return `הפעולה ${method} לא הסתיימה בזמן. נסו שוב; ספר גדול נטען בפעם הראשונה לאט יותר.`;
  if (code === "error.not_found") return `אוצריא לא מצאה את מה שהתבקש (${method}). בדקו שהספר קיים בספרייה.`;
  return `אוצריא החזירה שגיאה (${code}) בפעולה ${method}. נסו שוב; אם זה חוזר, דווחו עם קוד השגיאה.`;
}

/** The lines of a book's text as getBookContent returns it (assumed: the lines joined by "\n", see the header). */
export function linesOfContent(text: string): SourceLine[] {
  return text.split("\n").map((t, index) => {
    const heading = headingLevel(t);
    return { index, text: t, anchorText: t, heRef: null, heading, existsInDb: !(heading !== null && !stripTags(t).trim()) };
  });
}

/** BooksPort over library.getBookMetadata and library.getBookContent, in windows of at most 5,000 characters. */
export function otzariaBooks(call: OtzariaCall, opts: OtzariaHostOptions): BooksPort & { readCalls(): number } {
  const texts = new Map<string, Promise<SourceLine[]>>();
  let calls = 0;
  const cap = Math.max(1, opts.cachedBooks ?? 4);
  const load = (bookId: string, signal?: AbortSignal): Promise<SourceLine[]> => {
    const hit = texts.get(bookId);
    if (hit) {
      texts.delete(bookId);
      texts.set(bookId, hit);
      return hit;
    }
    const p = (async () => {
      let text = "";
      // one window after another until an empty one: a short window is not trusted as the end (the host may cut a window short)
      for (let offset = 0; ; ) {
        signal?.throwIfAborted();
        calls++;
        const part = await callHost<string>(call, "library.getBookContent", { bookId, offset, limit: SDK_LIMITS.contentChars, rawDivineNames: true }, opts);
        if (typeof part !== "string") throw new LinkerError("plugin/bad-content", `אוצריא החזירה תוכן שאינו טקסט לספר "${bookId}". ייתכן שזה קובץ PDF; התוסף מקשר ספרי טקסט בלבד.`);
        if (!part.length) break;
        if (part.length > SDK_LIMITS.contentChars) throw new LinkerError("plugin/bad-content", `אוצריא החזירה יותר מ־${SDK_LIMITS.contentChars} תווים בקריאה אחת לספר "${bookId}", בניגוד למגבלה המתועדת. דווחו על זה.`);
        text += part;
        offset += part.length;
      }
      return linesOfContent(text);
    })();
    p.catch(() => texts.delete(bookId));
    texts.set(bookId, p);
    while (texts.size > cap) texts.delete(texts.keys().next().value!);
    return p;
  };
  return {
    readCalls: () => calls,
    async list() {
      const out: SourceBook[] = [];
      for (const bookId of opts.books) {
        const meta = await callHost<{ title?: string; bookId?: string } | null>(call, "library.getBookMetadata", { bookId }, opts);
        if (!meta) throw new LinkerError("plugin/unknown-book", `הספר "${bookId}" לא נמצא בספרייה של אוצריא.`);
        out.push({ key: otzariaBookKey(bookId), title: meta.title ?? bookId, origin: "otzaria" });
      }
      return out;
    },
    async lines(key, from, to, signal) {
      const all = await load(bookIdOf(key), signal);
      return all.slice(Math.max(0, from), Math.min(all.length, to + 1));
    },
    async headings(key) {
      return (await load(bookIdOf(key))).filter((l) => l.heading !== null).map((l) => l.index);
    },
  };
}

/**
 * LinksPort over library.getRawLinks: windows of at most 1,000 lines; a truncated window is read again at half the size (the SDK:
 * there is no sign where the cut fell). The records are 1-based links.json records; the ONE conversion to the model is
 * formats/links-json/convert.ts. Each link is "db" provenance: the host's, read-only, never written back.
 */
export function otzariaLinks(call: OtzariaCall, books: BooksPort, opts: OtzariaHostOptions): LinksPort {
  return {
    async existing(key, signal) {
      const bookId = bookIdOf(key);
      const list = await books.list();
      const self = list.find((b) => b.key === key);
      const sourceRef: BookRef = { key, title: self?.title ?? bookId, origin: "otzaria" };
      const byTitle = new Map(list.map((b) => [b.title, { key: b.key, title: b.title, origin: b.origin } as BookRef]));
      const lineCount = (await books.lines(key, 0, Number.MAX_SAFE_INTEGER, signal)).length;
      const records: unknown[] = [];
      for (let start = 0, size: number = SDK_LIMITS.rawLinksWindow; start < lineCount; ) {
        signal?.throwIfAborted();
        const end = Math.min(lineCount - 1, start + size - 1);
        const got = await callHost<{ links: unknown[]; truncated: boolean }>(call, "library.getRawLinks", { bookId, startLine: start, endLine: end }, opts);
        if (got.truncated && size > 1) {
          size = Math.max(1, Math.floor(size / 2));
          continue;
        }
        records.push(...got.links);
        start = end + 1;
        size = SDK_LIMITS.rawLinksWindow;
      }
      const parsed = parseLinksJson(JSON.stringify(records));
      return parsed.records.map((rec, i): Link => {
        const { link } = recordToLink(rec, i, sourceRef, (t) => byTitle.get(t) ?? null, `host:${bookId}:${i}`);
        return { ...link, provenance: "db" };
      });
    },
  };
}

/** SearchPort over search.fullText: the hits in the book asked for, by line. */
export function otzariaSearch(call: OtzariaCall, books: BooksPort, opts: OtzariaHostOptions): SearchPort {
  return {
    async find(key, query) {
      const title = (await books.list()).find((b) => b.key === key)?.title ?? bookIdOf(key);
      const hits = await callHost<{ book: string; index: number; type?: string }[]>(call, "search.fullText", { query, limit: 500, rawDivineNames: true }, opts);
      return (hits ?? []).filter((h) => h.book === title && h.type !== "pdf").map((h) => ({ line: h.index }));
    },
  };
}

/** SavePort over fs.writeFile, in the plugin's private space (never the library: its books are read-only). */
export function otzariaSave(call: OtzariaCall, opts: OtzariaHostOptions): SavePort & { saved(): string[] } {
  const saved: string[] = [];
  const dir = (opts.saveDir ?? "linker").replace(/\/+$/, "");
  return {
    saved: () => [...saved],
    async save(file) {
      if (/[\\/]|^\.\.?$/.test(file.name)) throw new LinkerError("plugin/bad-file-name", `שם הקובץ "${file.name}" אינו שם קובץ פשוט. התוסף שומר רק קבצים בתיקייה שלו.`);
      const binary = typeof file.content !== "string";
      const bytes = binary ? (file.content as Uint8Array).length : new TextEncoder().encode(file.content as string).length;
      if (bytes > SDK_LIMITS.writeBytes) throw new LinkerError("plugin/file-too-large", `הקובץ "${file.name}" גדול מ־10MB, יותר ממה שאוצריא מאפשרת לכתוב בפעם אחת. קשרו פחות ספרים בכל ריצה.`);
      const path = `${dir}/${file.name}`;
      await callHost(call, "fs.writeFile", { path, content: binary ? base64(file.content as Uint8Array) : file.content, ...(binary && { encoding: "base64" }) }, opts);
      saved.push(path);
    },
  };
}

/** All the ports over one `Otzaria.call`: what a plugin passes to the headless core (headless/core.ts). */
export function otzariaAdapters(call: OtzariaCall, opts: OtzariaHostOptions & { progress?: LinkerAdapters["progress"]; cancel?: AbortSignal }): LinkerAdapters {
  const books = otzariaBooks(call, opts);
  return {
    books,
    links: otzariaLinks(call, books, opts),
    search: otzariaSearch(call, books, opts),
    save: otzariaSave(call, opts),
    ...(opts.progress && { progress: opts.progress }),
    ...(opts.cancel && { cancel: opts.cancel }),
  };
}

function base64(bytes: Uint8Array): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += abc[(n >> 18) & 63]! + abc[(n >> 12) & 63]! + (i + 1 < bytes.length ? abc[(n >> 6) & 63]! : "=") + (i + 2 < bytes.length ? abc[n & 63]! : "=");
  }
  return out;
}
