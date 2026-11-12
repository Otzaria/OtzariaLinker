import type { BookRef } from "../core/links/model";
import { ENGINES, type EngineId, type EngineResult, type Reason } from "./automatic";
import type { MergedSuggestion, MergeStats } from "./merge";
import type { PlanBookRow, PlanStep } from "./plan";

/*
 * The max-link report (plan stage 8.4): what was checked, what was found, and what became of it —
 * overall, per book and per engine — and the same as CSV. The live part (approved, rejected, already
 * exists) is recomputed from the suggestion states, so the report follows approvals and undo.
 */

/** What the worker returns for one step (workers/maxlink-job.ts). */
/** Units of max-link progress per step (and per book whose existing links are read at the end): engines report inside a step. */
export const MAXLINK_PROGRESS_UNIT = 1000;

export interface StepResult {
  stepId: string;
  /** the engine's result, without the per-line `unmatched` list (only its size crosses the worker) */
  result?: EngineResult;
  unmatched: number;
  /** Hebrew message when the step failed; the other steps ran */
  error?: string;
  /** wall time of the step, ms */
  ms: number;
}

export interface MaxLinkJobResult {
  items: StepResult[];
  /** linePairKey of every database link touching the books the steps read from */
  dbLinkKeys: string[];
}

export interface StepOutcome {
  id: string;
  kind: PlanStep["kind"];
  engine: EngineId;
  source: BookRef;
  target?: BookRef;
  /** raw suggestions of the step, before merging */
  raw: number;
  unmatched: number;
  ms: number;
  error?: string;
  notes: readonly Reason[];
}

/** Kept on the run (SuggestionRun.maxlink): the plan rows, every step's outcome and the merge counts. */
export interface MaxLinkRunInfo {
  /** e.g. 'המקור "2 קובצי טקסט"' (Hebrew) */
  scope: string;
  books: PlanBookRow[];
  identified: number;
  steps: StepOutcome[];
  stats: MergeStats;
  ms: number;
}

export type LiveState = "pending" | "approved" | "rejected" | "exists";

export interface ReportCounts {
  steps: number;
  /** merged suggestions */
  links: number;
  /** certain, not rejected and not existing: what "approve all certain" may take */
  certain: number;
  /** the rest that needs a look (high, possible, ambiguous) */
  review: number;
  approved: number;
  rejected: number;
  existing: number;
  /** raw suggestions folded into another one */
  duplicates: number;
  agreements: number;
  conflicts: number;
  errors: number;
}

export interface ReportRow extends ReportCounts {
  key: string;
  label: string;
  /** a problem or a skip reason (Hebrew) */
  note?: string;
}

export interface MaxLinkReport {
  overall: ReportCounts & { booksChecked: number; booksIdentified: number };
  perBook: ReportRow[];
  perEngine: ReportRow[];
}

const zero = (): ReportCounts => ({ steps: 0, links: 0, certain: 0, review: 0, approved: 0, rejected: 0, existing: 0, duplicates: 0, agreements: 0, conflicts: 0, errors: 0 });

function count(c: ReportCounts, s: MergedSuggestion, st: LiveState): void {
  c.links++;
  if (st === "exists") c.existing++;
  else if (st === "rejected") c.rejected++;
  else if (s.confidence === "certain") c.certain++;
  else c.review++;
  if (st === "approved") c.approved++;
  if (s.engines.length > 1) c.agreements++;
  if (s.rules.includes("maxlink/conflict")) c.conflicts++;
  c.duplicates += s.members.length - 1;
}

export function buildReport(info: MaxLinkRunInfo, suggestions: readonly MergedSuggestion[], stateOf: (id: string) => LiveState | undefined): MaxLinkReport {
  const overall = { ...zero(), booksChecked: info.books.length, booksIdentified: info.identified, steps: info.steps.length };
  const books = new Map<string, ReportRow>();
  const book = (ref: BookRef): ReportRow => {
    let row = books.get(ref.key);
    if (!row) books.set(ref.key, (row = { ...zero(), key: ref.key, label: ref.title }));
    return row;
  };
  for (const b of info.books) {
    const row = book(b.book);
    if (b.skipped) row.note = b.skipped;
  }
  const engines = new Map<EngineId, ReportRow>();
  const engine = (e: EngineId): ReportRow => {
    let row = engines.get(e);
    if (!row) engines.set(e, (row = { ...zero(), key: e, label: ENGINES.find((x) => x.id === e)?.title ?? e }));
    return row;
  };
  for (const s of info.steps) {
    const b = book(s.source);
    const e = engine(s.engine);
    b.steps++;
    e.steps++;
    e.duplicates += s.raw;
    if (s.error) {
      b.errors++;
      e.errors++;
      overall.errors++;
      b.note = s.error;
      e.note = s.error;
    }
  }
  for (const s of suggestions) {
    const st = stateOf(s.id) ?? "pending";
    count(overall, s, st);
    const ref = s.source.book.key === s.focus ? s.source.book : s.target.book;
    count(book(ref), s, st);
    for (const e of s.engines) count(engine(e), s, st);
  }
  // per engine, "duplicates" = its raw suggestions that did not become a suggestion it represents
  for (const [e, row] of engines) row.duplicates = Math.max(0, row.duplicates - suggestions.filter((s) => s.engine === e).length);
  return { overall, perBook: [...books.values()], perEngine: [...engines.values()] };
}

const HEAD = ["רמה", "ספר / שיטה", "שלבים", "הצעות", "ודאיות (לאישור)", "לבדיקה", "אושרו", "נדחו", "כבר קיימים", "כפילויות שאוחדו", "הסכמות בין שיטות", "סתירות", "שגיאות", "הערה"];

/** The report as CSV (UTF-8 with BOM, CRLF — opens in Excel with Hebrew intact, like the QA report). */
export function reportCsv(rep: MaxLinkReport): string {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const line = (level: string, label: string, c: ReportCounts, note = "") =>
    [level, label, c.steps, c.links, c.certain, c.review, c.approved, c.rejected, c.existing, c.duplicates, c.agreements, c.conflicts, c.errors, note].map(esc).join(",");
  const rows = [
    HEAD.map(esc).join(","),
    line("כולל", `${rep.overall.booksChecked} ספרים נבדקו, ל־${rep.overall.booksIdentified} נמצא קשר`, rep.overall),
    ...rep.perBook.map((r) => line("ספר", r.label, r, r.note)),
    ...rep.perEngine.map((r) => line("שיטה", r.label, r, r.note)),
  ];
  return `﻿${rows.join("\r\n")}\r\n`;
}
