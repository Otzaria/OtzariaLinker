import type { OtzariaCall, OtzariaResponse } from "../../src/headless/otzaria-host";

/*
 * A simulated `Otzaria.call` (plugin SDK 1.x) for the headless core's tests — the harness of docs/PLUGIN_READINESS.md §4. It keeps
 * the limits the SDK documents (Otzaria/otzaria docs/plugin-sdk README "Host API", "אבטחה ומגבלות" and API_REFERENCE, read at
 * a6be90800, 2026-11-22), and fails a call the way the real host says it does, so a test proves the adapter keeps them:
 *   library.getBookContent   at most 5,000 characters a call (limit > 5000 → error.invalid_params); offset/limit in characters
 *   library.getRawLinks      startLine/endLine together, 0-based; a window over 1,000 lines → error.invalid_params; records are
 *                            1-based links.json records; more than `maxRawLinks` in a window → `truncated: true`
 *   rate limiting            a bucket of 50 tokens, one back every 10 ms (a fake clock: `advance`); getBookContent is exempt when
 *                            library.content.read is granted
 *   permissions              a method whose permission is not granted → error.permission_denied
 *   fs.*                     the plugin's private space: no "..", no absolute path (error.forbidden), 10 MB a call
 *   library books            read-only: there is no method that writes them (any other method → error.unknown_method)
 * It is a model of the documents, NOT of Otzaria: what the documents do not say (that the content is the lines joined by "\n")
 * is what the simulator assumes, and docs/PLUGIN_READINESS.md lists it as unverified.
 */
export interface SimBook {
  bookId: string;
  title?: string;
  lines: readonly string[];
  /** the host's links of the book, as getRawLinks returns them (1-based, the five keys of links.json) */
  links?: readonly Record<string, unknown>[];
}

export interface SimOptions {
  books: readonly SimBook[];
  /** the permissions granted (default: all the core needs) */
  granted?: readonly string[];
  /** links in one getRawLinks answer before it is cut (`truncated`); the SDK: 10,000 */
  maxRawLinks?: number;
  /** enforce the rate limiter (default true) */
  rateLimit?: boolean;
}

const PERMISSION: Readonly<Record<string, string | null>> = {
  "library.getBookMetadata": "library.books.read",
  "library.findBooks": "library.books.read",
  "library.getBookContent": "library.content.read",
  "library.getBookToc": "library.content.read",
  "library.getRawLinks": "library.links.read",
  "search.fullText": "search.fulltext.read",
  "fs.writeFile": null,
  "fs.readFile": null,
  "ui.showSuccess": "ui.feedback",
  "ui.showError": "ui.feedback",
};
export const CORE_PERMISSIONS = ["library.books.read", "library.content.read", "library.links.read", "search.fulltext.read", "ui.feedback"];

export interface Sim {
  call: OtzariaCall;
  /** every call made, in order */
  log: { method: string; payload: Record<string, unknown> }[];
  /** the plugin's private files */
  files: Map<string, string>;
  /** what ui.showSuccess / ui.showError said */
  messages: { kind: "success" | "error"; message: string }[];
  /** the fake clock (ms) */
  now(): number;
  advance(ms: number): void;
}

export function otzariaSim(opts: SimOptions): Sim {
  const books = new Map(opts.books.map((b) => [b.bookId, b]));
  const granted = new Set(opts.granted ?? CORE_PERMISSIONS);
  const log: Sim["log"] = [];
  const files = new Map<string, string>();
  const messages: Sim["messages"] = [];
  let clock = 0;
  let tokens = 50;
  let refilledAt = 0;
  const ok = <T>(data: T): OtzariaResponse<T> => ({ success: true, data, error: null });
  const fail = (code: string, message = code): OtzariaResponse<never> => ({ success: false, data: null, error: { code, message } });
  const book = (p: Record<string, unknown>) => books.get(String(p.bookId));

  const call: OtzariaCall = async (method, payload = {}) => {
    log.push({ method, payload });
    if (!(method in PERMISSION)) return fail("error.unknown_method");
    const perm = PERMISSION[method]!;
    const exempt = method === "library.getBookContent" && granted.has("library.content.read");
    if (opts.rateLimit !== false && !exempt) {
      const back = Math.floor((clock - refilledAt) / 10);
      if (back > 0) (tokens = Math.min(50, tokens + back)), (refilledAt += back * 10);
      if (tokens <= 0) return fail("error.rate_limited");
      tokens--;
    }
    if (perm && !granted.has(perm)) return fail("error.permission_denied", `missing permission ${perm}`);
    switch (method) {
      case "library.getBookMetadata": {
        const b = book(payload);
        return ok(b ? { bookId: b.bookId, title: b.title ?? b.bookId } : null);
      }
      case "library.findBooks":
        return ok([...books.values()].filter((b) => (b.title ?? b.bookId).includes(String(payload.query ?? ""))).map((b) => ({ bookId: b.bookId, title: b.title ?? b.bookId })));
      case "library.getBookContent": {
        const b = book(payload);
        if (!b) return fail("error.not_found");
        const limit = payload.limit === undefined ? 1000 : Number(payload.limit);
        if (!(limit > 0) || limit > 5000) return fail("error.invalid_params", "limit is at most 5000");
        const offset = Number(payload.offset ?? 0);
        return ok(b.lines.join("\n").slice(offset, offset + limit));
      }
      case "library.getRawLinks": {
        const b = book(payload);
        if (!b) return fail("error.not_found");
        if ((payload.startLine === undefined) !== (payload.endLine === undefined)) return fail("error.invalid_params", "startLine and endLine go together");
        const start = Number(payload.startLine ?? 0);
        const end = Number(payload.endLine ?? 999);
        if (end - start + 1 > 1000) return fail("error.invalid_params", "a window is at most 1000 lines");
        const inWindow = (b.links ?? []).filter((l) => Number(l.line_index_1) - 1 >= start && Number(l.line_index_1) - 1 <= end);
        const max = opts.maxRawLinks ?? 10_000;
        return ok({ links: inWindow.slice(0, max), truncated: inWindow.length > max, startLine: start, endLine: end });
      }
      case "search.fullText": {
        const q = String(payload.query ?? "");
        const hits = [...books.values()].flatMap((b) => b.lines.flatMap((t, index) => (t.includes(q) ? [{ type: "text", book: b.title ?? b.bookId, text: t.slice(0, 80), index }] : [])));
        return ok(hits.slice(0, Number(payload.limit ?? 50)));
      }
      case "fs.writeFile": {
        const path = String(payload.path ?? "");
        if (!path || path.includes("..") || /^([a-zA-Z]:|[\\/])/.test(path)) return fail("error.forbidden");
        const content = String(payload.content ?? "");
        const size = payload.encoding === "base64" ? Math.floor((content.length * 3) / 4) : new TextEncoder().encode(content).length;
        if (size > 10 * 1024 * 1024) return fail("error.too_large");
        files.set(path, content);
        return ok({ path, size, usedBytes: size, quotaBytes: 100 * 1024 * 1024 });
      }
      case "ui.showSuccess":
      case "ui.showError":
        messages.push({ kind: method === "ui.showSuccess" ? "success" : "error", message: String(payload.message ?? "") });
        return ok(true);
      case "fs.readFile": {
        const path = String(payload.path ?? "");
        return files.has(path) ? ok({ path, encoding: "utf8", size: files.get(path)!.length, content: files.get(path) }) : fail("error.not_found");
      }
    }
    return fail("error.unknown_method");
  };
  return { call, log, files, messages, now: () => clock, advance: (ms) => void (clock += ms) };
}
