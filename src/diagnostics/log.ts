/**
 * Structured, bounded, exportable log (architecture rule 16). Entries never contain book text by
 * default — only ids, counts and codes — so a log a user attaches to a bug report is safe to share.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** ms since epoch */
  t: number;
  level: LogLevel;
  /** dotted area, e.g. "db.open", "export.links-json" */
  area: string;
  msg: string;
  code?: string;
  data?: Readonly<Record<string, unknown>>;
}

export class Log {
  private readonly buf: LogEntry[] = [];
  private readonly listeners = new Set<(e: LogEntry) => void>();

  constructor(
    private readonly capacity = 5000,
    private readonly now: () => number = Date.now,
  ) {}

  debug(area: string, msg: string, data?: LogEntry["data"]) { this.add("debug", area, msg, data); }
  info(area: string, msg: string, data?: LogEntry["data"]) { this.add("info", area, msg, data); }
  warn(area: string, msg: string, data?: LogEntry["data"], code?: string) { this.add("warn", area, msg, data, code); }
  error(area: string, msg: string, data?: LogEntry["data"], code?: string) { this.add("error", area, msg, data, code); }

  entries(): readonly LogEntry[] {
    return this.buf;
  }

  /** One JSON object per line — easy to grep and to attach to an issue. */
  toJsonl(): string {
    return this.buf.map((e) => JSON.stringify(e)).join("\n") + (this.buf.length ? "\n" : "");
  }

  subscribe(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private add(level: LogLevel, area: string, msg: string, data?: LogEntry["data"], code?: string) {
    const e: LogEntry = { t: this.now(), level, area, msg, ...(code ? { code } : {}), ...(data ? { data } : {}) };
    this.buf.push(e);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    for (const fn of this.listeners) fn(e);
  }
}
