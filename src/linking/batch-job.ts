import { humanCsvCell } from "../core/csv";
import type { BookRef } from "../core/links/model";
import { combineFingerprints } from "../core/text/fingerprint";
import { ENGINES, type EngineId, type Suggestion } from "./automatic";
import { sanitizeStoredOptions } from "./automatic/option-specs";
import type { StepResult } from "./maxlink-report";
import type { MaxLinkPlan, PlanStep } from "./plan";

/*
 * The batch job (V5 P1-8, "Jobs" and incremental linking): a max-link plan run book after book, so a
 * run of hundreds or thousands of books can be followed per book and per engine, paused and resumed
 * (also after the tab was closed: state/maxlink.ts keeps it in the browser next to the autosave),
 * cancelled without losing the books that finished, continued past a book that fails, re-run on the
 * failed books only, and run again after books changed while skipping the ones that did not (their
 * fingerprints, core/text/fingerprint.ts). This module is the pure part: the record, the book of each
 * step, the statuses, the fingerprint of a book's work, session-free suggestion ids and the per-book
 * report. The job is a max-link run — there is no second job system: the steps, the worker job and the
 * merge are max-link's own (plan.ts, workers/maxlink-job.ts, merge.ts).
 */

export type JobBookStatus = "pending" | "done" | "no-match" | "failed" | "unchanged" | "not-planned";
export type JobState = "running" | "paused" | "cancelled" | "done";

/** Steps of one engine on one book: planned, done (with or without suggestions), failed. */
export type EngineTally = [planned: number, done: number, failed: number];

export interface JobBook {
  /** the book's title: a job outlives the session's book keys */
  title: string;
  status: JobBookStatus;
  /** failed: the errors; not-planned: the planner's reason; unchanged: since when */
  why?: string;
  engines: Partial<Record<EngineId, EngineTally>>;
  /** raw suggestions of its steps (before the merge) */
  suggestions: number;
  ms: number;
  /** of the book, its bases and its steps when it last ran (bookFingerprint) */
  fingerprint?: string;
  /** it changed since its last run, and the user had decided on this many suggestions on it: kept, to check */
  changedDecisions?: number;
  /**
   * Stopped while it ran (pause, stop): it still waits, and the suggestions its engines found until then
   * — this many — are shown, marked partial. "המשך" runs it again from its start.
   */
  partial?: number;
}

export interface JobRecord {
  v: 1;
  id: string;
  /** "המקור 'פירושים'" — what was linked, as the report names it */
  scope: string;
  /** the labels of the sources the books came from: what to open again after a reload */
  sources: string[];
  /** the engines left ticked (absent: all) */
  engines?: EngineId[];
  engineOptions?: Partial<Record<EngineId, Record<string, unknown>>>;
  /** the label of the source chosen for the bases, when a base was open twice */
  preferBase?: string;
  state: JobState;
  books: JobBook[];
  startedAt: number;
  /** working time so far (pauses not counted) */
  ms: number;
}

/** A step as a book's stored result keeps it: what the report and the merge need, bound to titles. */
export interface StoredStep {
  id: string;
  kind: PlanStep["kind"];
  engine: EngineId;
  target?: BookRef;
  item: StepResult;
}

/** What one book's run left: kept in memory and in the browser until the job is replaced. */
export interface BookResult {
  title: string;
  /** what the book's engines found before the job was stopped (MaxLinkJobResult.stopped): shown, never kept as its result */
  partial?: boolean;
  source: BookRef;
  steps: StoredStep[];
  /** linePairKey (by titles) of the database links of the book */
  dbLinkKeys: string[];
  dbLinksUnread?: { title: string; why: string }[];
}

/** The steps of each linked book (the plan's focus: the step's source), in the order of the plan's books. */
export function stepsByBook(plan: MaxLinkPlan): Map<string, PlanStep[]> {
  const by = new Map<string, PlanStep[]>();
  for (const row of plan.books) by.set(row.book.key, []);
  for (const s of plan.steps) {
    const list = by.get(s.source.key);
    if (list) list.push(s);
    else by.set(s.source.key, [s]);
  }
  for (const [k, list] of by) if (!list.length) by.delete(k);
  return by;
}

const tallies = (steps: readonly PlanStep[]): Partial<Record<EngineId, EngineTally>> => {
  const out: Partial<Record<EngineId, EngineTally>> = {};
  for (const s of steps) (out[s.engine] ??= [0, 0, 0])[0]++;
  return out;
};

const NATURAL = new Intl.Collator("he", { numeric: true });

/**
 * The order the waiting books run in: books that read the same other books (a base, the commentaries on
 * it they quote) next to each other, groups in the order they first appear, titles in natural order
 * ("ביאור 2" before "ביאור 10") inside a group. Not the plan's order: that is the order the files were
 * opened in, and a chosen folder arrives in the file system's order (NTFS: by name, ext4: by hash), so
 * the same folder would run, pause and report in a different order on each machine. The worker keeps the last few books it read (workers/maxlink-job.ts), and the books of one base
 * then hit it: in the plan's order a folder alternates between bases, and against the Otzaria database
 * 100 commentaries on the five books of the Torah took 302 s, in this order 154 s (one call for all: 202 s).
 */
export function runOrder(titles: readonly string[], steps: ReadonlyMap<string, readonly PlanStep[]>): string[] {
  const groups = new Map<string, string[]>();
  // Array.sort is stable: equal titles (a clash across folders) keep the plan's order
  for (const t of [...titles].sort(NATURAL.compare)) {
    const k = [...new Set((steps.get(t) ?? []).flatMap((s) => (s.kind === "pair" ? [s.target.key] : [])))].sort().join("|");
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  return [...groups.values()].flat();
}

/** A new job of a plan: a book with steps waits; one without is "not planned", with the planner's reason. */
export function jobFromPlan(plan: MaxLinkPlan, meta: Pick<JobRecord, "scope" | "sources" | "engines" | "engineOptions" | "preferBase">, now = Date.now()): JobRecord {
  const by = stepsByBook(plan);
  const books: JobBook[] = plan.books.map((row) => {
    const steps = by.get(row.book.key) ?? [];
    return steps.length
      ? { title: row.book.title, status: "pending", engines: tallies(steps), suggestions: 0, ms: 0 }
      : { title: row.book.title, status: "not-planned", why: row.skipped ?? row.unpaired ?? "לא נמצאה שיטה שמתאימה לספר.", engines: {}, suggestions: 0, ms: 0 };
  });
  return { v: 1, id: now.toString(36), ...meta, state: "running", books, startedAt: now, ms: 0 };
}

/**
 * What a book's result depends on besides the texts: its steps (engine, kind, the other book, the
 * plan's options for the pair) and the user's settings of those engines. A change of any of them runs
 * the book again even when no text changed.
 */
export function stepsSignature(steps: readonly PlanStep[], engineOptions?: JobRecord["engineOptions"]): string {
  const parts = steps.map((s) => `${s.engine}|${s.kind}|${s.kind === "pair" ? s.target.title : ""}|${s.kind === "pair" && s.options ? JSON.stringify(s.options) : ""}`).sort();
  const engines = [...new Set(steps.map((s) => s.engine))].sort();
  return JSON.stringify([parts, engines.map((e) => engineOptions?.[e] ?? null)]);
}

/**
 * The fingerprint of a book's work: its own text, the text of every book its pair steps read, and the
 * steps' signature. Undefined when one of the texts has no fingerprint (unreadable): such a book is
 * never skipped as unchanged.
 */
export function bookFingerprint(steps: readonly PlanStep[], fps: Readonly<Record<string, string>>, engineOptions?: JobRecord["engineOptions"]): string | undefined {
  const source = steps[0]?.source;
  if (!source || !fps[source.key]) return undefined;
  const others = [...new Set(steps.flatMap((s) => (s.kind === "pair" ? [s.target.key] : [])))];
  if (others.some((k) => !fps[k])) return undefined;
  const titleOf = new Map(steps.flatMap((s) => (s.kind === "pair" ? [[s.target.key, s.target.title] as const] : [])));
  const bases = others.map((k) => `${titleOf.get(k)}=${fps[k]}`).sort();
  return combineFingerprints([fps[source.key]!, ...bases, stepsSignature(steps, engineOptions)]);
}

/** Every book key a book's fingerprint reads. */
export const fingerprintKeys = (steps: readonly PlanStep[]): string[] => [...new Set([steps[0]?.source.key ?? "", ...steps.flatMap((s) => (s.kind === "pair" ? [s.target.key] : []))].filter(Boolean))];

/**
 * A suggestion id without the session's book keys. Engines build ids from book keys ("s1:פירוש.txt#4>
 * s2:17#3"), and the keys change whenever the folder is opened again: an approval ("auto:<id>") of the
 * last session would no longer be recognised as this suggestion's — and an edited one would be offered
 * again as new. With titles in place of keys the same suggestion has the same id in every session.
 */
export function stableId(s: Pick<Suggestion, "id" | "source" | "target">): string {
  let id = s.id;
  for (const b of [s.source.book, s.target.book]) if (b.key !== b.title) id = id.split(`${b.key}#`).join(`${b.title}#`);
  return id;
}

/** The step results with session-free suggestion ids. */
export function withStableIds(item: StepResult): StepResult {
  if (!item.result) return item;
  return { ...item, result: { ...item.result, suggestions: item.result.suggestions.map((s) => ({ ...s, id: stableId(s) })) } };
}

/** A book's status from its steps' results: failed when a step failed, else done or "no match". */
export function finishBook(book: JobBook, steps: readonly { engine: EngineId; error?: string; suggestions: number }[], ms: number, fingerprint: string | undefined): JobBook {
  const engines: Partial<Record<EngineId, EngineTally>> = {};
  for (const [e, t] of Object.entries(book.engines) as [EngineId, EngineTally][]) engines[e] = [t[0], 0, 0];
  let suggestions = 0;
  const errors: string[] = [];
  for (const s of steps) {
    const t = (engines[s.engine] ??= [0, 0, 0]);
    if (s.error !== undefined) (t[2]++, errors.push(s.error));
    else t[1]++;
    suggestions += s.suggestions;
  }
  const { why: _w, changedDecisions: _c, partial: _p, ...rest } = book;
  const status: JobBookStatus = errors.length ? "failed" : suggestions ? "done" : "no-match";
  return { ...rest, status, engines, suggestions, ms, ...(fingerprint && { fingerprint }), ...(errors.length && { why: [...new Set(errors)].join(" · ") }), ...(book.changedDecisions && { changedDecisions: book.changedDecisions }) };
}

/** A book that failed (the whole call failed: the worker could not read it, or crashed on it). */
export function failBook(book: JobBook, why: string, ms: number): JobBook {
  const engines: Partial<Record<EngineId, EngineTally>> = {};
  for (const [e, t] of Object.entries(book.engines) as [EngineId, EngineTally][]) engines[e] = [t[0], 0, t[0]];
  const { fingerprint: _f, partial: _p, ...rest } = book;
  return { ...rest, status: "failed", why, engines, suggestions: 0, ms };
}

/** Counts by status, and per engine: steps planned, done and failed over the whole job. */
export function jobTotals(job: JobRecord): { byStatus: Record<JobBookStatus, number>; engines: { engine: EngineId; title: string; planned: number; done: number; failed: number }[]; settled: number; runnable: number } {
  const byStatus: Record<JobBookStatus, number> = { pending: 0, done: 0, "no-match": 0, failed: 0, unchanged: 0, "not-planned": 0 };
  const per = new Map<EngineId, EngineTally>();
  for (const b of job.books) {
    byStatus[b.status]++;
    for (const [e, t] of Object.entries(b.engines) as [EngineId, EngineTally][]) {
      const s = per.get(e) ?? [0, 0, 0];
      // an unchanged book's steps are done: its earlier result stands
      per.set(e, [s[0] + t[0], s[1] + (b.status === "unchanged" ? t[0] : t[1]), s[2] + (b.status === "unchanged" ? 0 : t[2])]);
    }
  }
  const engines = ENGINES.filter((e) => per.has(e.id)).map((e) => ({ engine: e.id, title: e.title, planned: per.get(e.id)![0], done: per.get(e.id)![1], failed: per.get(e.id)![2] }));
  const runnable = job.books.length - byStatus["not-planned"];
  return { byStatus, engines, settled: runnable - byStatus.pending, runnable };
}

export const STATUS_TEXT: Readonly<Record<JobBookStatus, string>> = {
  pending: "ממתין",
  done: "הסתיים",
  "no-match": "בלי התאמה",
  failed: "נכשל",
  unchanged: "לא השתנה, דולג",
  "not-planned": "לא קושר",
};

/** The per-book report as CSV (Excel opens it: BOM, CRLF). */
export function jobCsv(job: JobRecord): string {
  const esc = humanCsvCell;
  const title = new Map(ENGINES.map((e) => [e.id, e.title]));
  const rows = [
    ["ספר", "מצב", "הצעות", "שיטות", "שניות", "פירוט"].map(esc).join(","),
    ...job.books.map((b) =>
      [
        b.title,
        STATUS_TEXT[b.status],
        b.status === "not-planned" ? "" : b.suggestions,
        (Object.entries(b.engines) as [EngineId, EngineTally][]).map(([e, t]) => `${title.get(e) ?? e} ${b.status === "unchanged" ? t[0] : t[1]}/${t[0]}${t[2] ? ` (${t[2]} נכשלו)` : ""}`).join("; "),
        (b.ms / 1000).toFixed(1),
        [b.why, b.changedDecisions ? `הספר השתנה מאז ההרצה הקודמת: ${b.changedDecisions} החלטות שלכם עליו נשמרו כמו שהן — בדקו אותן` : ""].filter(Boolean).join(" · "),
      ]
        .map(esc)
        .join(","),
    ),
  ];
  return `﻿${rows.join("\r\n")}\r\n`;
}

/** The stored per-engine options, each validated like the form's (option-specs.ts): a hostile or damaged value is dropped. */
function storedEngineOptions(stored: object): NonNullable<JobRecord["engineOptions"]> {
  const out: NonNullable<JobRecord["engineOptions"]> = {};
  for (const e of ENGINES) {
    const o = sanitizeStoredOptions(e.id, (stored as Record<string, unknown>)[e.id]);
    if (Object.keys(o).length) out[e.id] = o;
  }
  return out;
}

/** Parses a stored record; null when it is not one (an older or damaged entry is dropped, never trusted). */
export function parseJobRecord(text: string | null | undefined): JobRecord | null {
  if (!text) return null;
  try {
    const r = JSON.parse(text) as Partial<JobRecord>;
    if (r?.v !== 1 || typeof r.id !== "string" || !Array.isArray(r.books) || !Array.isArray(r.sources)) return null;
    const states: JobState[] = ["running", "paused", "cancelled", "done"];
    const statuses = new Set<JobBookStatus>(["pending", "done", "no-match", "failed", "unchanged", "not-planned"]);
    const books = r.books.filter((b): b is JobBook => !!b && typeof b.title === "string" && statuses.has(b.status) && typeof b.engines === "object" && b.engines !== null);
    return {
      v: 1,
      id: r.id,
      scope: typeof r.scope === "string" ? r.scope : "",
      sources: r.sources.filter((s): s is string => typeof s === "string"),
      ...(Array.isArray(r.engines) && { engines: r.engines.filter((e): e is EngineId => ENGINES.some((x) => x.id === e)) }),
      ...(r.engineOptions && typeof r.engineOptions === "object" && !Array.isArray(r.engineOptions) && { engineOptions: storedEngineOptions(r.engineOptions) }),
      ...(typeof r.preferBase === "string" && { preferBase: r.preferBase }),
      // a job that was running when the tab closed is paused: nothing runs until the user says so
      state: r.state === "running" || !states.includes(r.state as JobState) ? "paused" : r.state!,
      books: books.map((b) => ({ ...b, suggestions: Number(b.suggestions) || 0, ms: Number(b.ms) || 0 })),
      startedAt: Number(r.startedAt) || 0,
      ms: Number(r.ms) || 0,
    };
  } catch {
    return null;
  }
}
