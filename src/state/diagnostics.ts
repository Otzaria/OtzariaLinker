import { Log, type LogEntry } from "../diagnostics/log";

/*
 * The app's diagnostic log (architecture rule 16): every notice the user saw, every long task with
 * its duration and outcome, worker restarts and uncaught errors, kept in memory (bounded) and saved
 * on request as JSONL for a bug report. Book CONTENT never enters the log — only titles, file names,
 * counts, codes and timings — so the file is safe to attach to a public issue.
 */

export interface DiagnosticsHeader {
  app: string;
  commit: string;
  built: string;
  savedAt: string;
  userAgent: string;
  /** what was open: kinds and sizes, no content */
  sources: { kind: string; books: number }[];
  links: number;
  prefs: Record<string, unknown>;
}

export const diagnosticsLog = (): Log => new Log(5000);

/** "error" notices are errors, "warning" warnings, everything else info. */
export function logNotice(log: Log, kind: string, text: string, details?: readonly string[]): void {
  const data = details?.length ? { details: details.slice(0, 50) } : undefined;
  if (kind === "error") log.error("notice", text, data);
  else if (kind === "warning") log.warn("notice", text, data);
  else log.info("notice", text, data);
}

/**
 * Wraps a long task: logs its start, and its end with the duration and outcome. The outcome is
 * "ok", "cancelled", or "failed" with the error's code (LinkerError codes are stable strings).
 */
export function logTask(log: Log, label: string, now: () => number = Date.now) {
  const started = now();
  log.debug("task", label);
  return {
    ok: () => log.info("task", label, { ms: now() - started, outcome: "ok" }),
    cancelled: () => log.info("task", label, { ms: now() - started, outcome: "cancelled" }),
    failed: (err: unknown) => {
      const e = err as { code?: string; message?: string };
      log.error("task", label, { ms: now() - started, outcome: "failed", message: e?.message ?? String(err) }, e?.code);
    },
  };
}

/** The saved file: a header object on the first line, then one entry per line. */
export function diagnosticsFile(header: DiagnosticsHeader, entries: readonly LogEntry[]): string {
  return [JSON.stringify({ header }), ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n";
}

export const diagnosticsFileName = (d = new Date()): string => `otzaria-linker-diagnostics-${d.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jsonl`;
