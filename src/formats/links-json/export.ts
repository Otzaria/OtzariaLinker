import { zipSync, strToU8 } from "fflate";
import { LinkerError } from "../../core/errors";
import type { Link } from "../../core/links/model";
import { exportVerdicts, FILE_LEVEL_CODES, type Problem, type ValidationContext } from "../../core/links/validate";
import { linkToRecord } from "./convert";
import type { JsonLayout } from "./layout";
import { serializeLinksJson } from "./serialize";

/*
 * Turns the project's links into `<book>_links.json` files and a plan the confirmation screen shows
 * BEFORE anything is written (how many new/kept/excluded, which files, why).
 *
 * A links file REPLACES the book's file in the library. So:
 *   • links imported from a file are written back in their original order (minimal diff), minus deletions;
 *   • new links follow, in a deterministic order;
 *   • for a book with no imported file, the plan warns that an existing library file would be overwritten;
 *   • a link with an error is held back (never written silently) and listed with its reasons — but a
 *     library record is never left out of a file that is written: its whole file is held instead (C1);
 *   • for private use, a "source" link is written in its BASE's file as "commentary" (validate.ts
 *     PRIVATE_TO_BASE: Otzaria's personal import does not reverse "source"), and the plan says which file;
 *   • the accounting adds up, or the export stops (exportAccounting): every link is written or held back
 *     with a reason, every deletion is delivered or held with a reason (V5 P0-5).
 */
export interface ExportFile {
  /** file name inside the export ("<source title>_links.json") */
  name: string;
  sourceTitle: string;
  text: string;
  records: number;
  /** true when no links file was imported for this book — the library may already have one */
  isNewFile: boolean;
  /** the records of the book's links file as it was loaded, which this file replaces (absent: none loaded) — "before → after" */
  before?: number;
  /**
   * Private use: records of OTHER books' links written into this book's file (a commentary's "source"
   * link, written here as "commentary" — validate.ts PRIVATE_TO_BASE), by the book whose link they are
   */
  movedIn?: { from: string; records: number }[];
}

export interface ExportPlan {
  files: ExportFile[];
  written: Link[];
  heldBack: { link: Link; problems: Problem[] }[];
  warned: { link: Link; problems: Problem[] }[];
  /**
   * Library records the user deleted whose deletion this export does NOT deliver — their book's file is
   * not written (a snapshot from a saved project, an unsafe title, a held file) — each with the reason
   */
  heldDeletions: { link: Link; problems: Problem[] }[];
  /** private use: link id → the record written for it in another book's file (a "source" link at its base) */
  moved: ReadonlyMap<string, Link>;
  /** deleted: deletions the written files deliver; deletionsHeld: those that wait (heldDeletions) */
  counts: { new: number; edited: number; kept: number; deleted: number; deletionsHeld: number; heldBack: number; files: number; movedToBase: number };
}

export interface ExportOptions {
  /** also write links with errors (expert mode) — default false */
  includeErrors?: boolean;
  /** the text layout of each book's imported file (formats/links-json/layout.ts); new files get the default */
  layouts?: (sourceTitle: string) => JsonLayout | undefined;
  /** the book's library file was loaded (it may hold no records): its file is not "new" */
  loadedFile?: (sourceTitle: string) => boolean;
  /** how many records the book's loaded links file had (ExportFile.before) */
  recordsBefore?: (sourceTitle: string) => number | undefined;
}

export function planExport(links: readonly Link[], ctx: ValidationContext, opts: ExportOptions = {}): ExportPlan {
  // ONE classification for the export and the quality check (validate.ts exportVerdicts)
  const v = exportVerdicts(links, ctx, opts.includeErrors === true);
  const { written, heldBack, warned, heldDeletions, moved } = v;

  const bySource = new Map<string, Link[]>();
  /** file title → the book each moved record came from → how many */
  const movedIn = new Map<string, Map<string, number>>();
  // push, not spread: one book's file can hold 100k+ records (the library's largest has 112,905),
  // and copying the list for every link made planning quadratic — 259 s for that one file
  for (const l of written) {
    // private use: a "source" link goes into its base's file, as the validation said (PRIVATE_TO_BASE)
    const atBase = moved.get(l.id);
    const record = atBase ?? l;
    if (atBase) {
      const from = movedIn.get(atBase.source.book.title) ?? new Map<string, number>();
      from.set(l.source.book.title, (from.get(l.source.book.title) ?? 0) + 1);
      movedIn.set(atBase.source.book.title, from);
    }
    const list = bySource.get(record.source.book.title);
    if (list) list.push(record);
    else bySource.set(record.source.book.title, [record]);
  }
  const importedTitles = new Set(links.filter((l) => l.provenance === "file").map((l) => l.source.book.title));

  // A book whose imported links were ALL deleted still needs its file — empty — or the library's old
  // file would stay and the deletions would never happen (compatibility review #2); exportVerdicts
  // decides which, by the file rules.
  for (const title of v.emptyFiles) if (!bySource.has(title)) bySource.set(title, []);

  assertNoLibraryRecordDropped(links, written, bySource);

  const files: ExportFile[] = [...bySource.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([title, list]) => {
      const ordered = [...list].sort(fileOrder);
      const from = movedIn.get(title);
      const before = opts.recordsBefore?.(title);
      return {
        name: `${title}_links.json`,
        sourceTitle: title,
        text: serializeLinksJson(ordered.map(linkToRecord), opts.layouts?.(title)),
        records: ordered.length,
        isNewFile: !importedTitles.has(title) && !opts.loadedFile?.(title),
        ...(before !== undefined && { before }),
        ...(from && { movedIn: [...from].sort(([a], [b]) => cmp(a, b)).map(([t, records]) => ({ from: t, records })) }),
      };
    });

  const plan: ExportPlan = {
    files,
    written,
    heldBack,
    warned,
    heldDeletions,
    moved,
    counts: {
      new: written.filter((l) => l.status === "new").length,
      edited: written.filter((l) => l.status === "edited").length,
      kept: written.filter((l) => l.status === "existing").length,
      deleted: v.deletions.length,
      deletionsHeld: heldDeletions.length,
      heldBack: heldBack.length,
      files: files.length,
      movedToBase: moved.size,
    },
  };
  assertExportAccounting(links, plan);
  return plan;
}

/*
 * What the export does with EACH link the project holds (V7 §1.9) — every live, non-database link gets exactly one:
 *
 *   written      a new or edited link, written as a record
 *   unchanged    a library record the user did not touch, written back as it was
 *   merged       written, but the same stored link as another link of this export: the database holds them as one
 *   blocked      held back only because its book's whole file is held (the file's problem, or another link's)
 *   needs-fix    held back for an error of its own
 *   unsupported  held back because no links file can carry it (a "linker" record, Sefaria↔Sefaria, INLINE_LINKER for
 *                the library), or written to the links files but left out of the chosen format (`omitted`: the
 *                Sefaria CSV's sefariaCsvOmissions)
 *
 * Derived from the plan only, so it can never disagree with what is written: written + unchanged + merged = plan.written,
 * blocked + needs-fix + unsupported = plan.heldBack (plus `omitted` moved from the first to the last).
 */
export const EXPORT_OUTCOMES = ["written", "unchanged", "merged", "blocked", "needs-fix", "unsupported"] as const;
export type ExportOutcome = (typeof EXPORT_OUTCOMES)[number];

/** what no links file can carry: the generator skips the record, or the library does not know the type */
const UNSUPPORTED_CODES: ReadonlySet<string> = new Set(["export/linker", "export/sefaria-both", "export/inline-linker-private-only"]);

export function exportOutcomes(plan: Pick<ExportPlan, "written" | "heldBack" | "warned">, omitted: Iterable<string> = []): Map<string, ExportOutcome> {
  const out = new Map<string, ExportOutcome>();
  const left = new Set(omitted);
  const duplicate = new Set(plan.warned.filter((w) => w.problems.some((p) => p.code === "export/duplicate")).map((w) => w.link.id));
  for (const l of plan.written) out.set(l.id, left.has(l.id) ? "unsupported" : l.status === "existing" ? "unchanged" : duplicate.has(l.id) ? "merged" : "written");
  for (const { link, problems } of plan.heldBack) {
    const errors = problems.filter((p) => p.severity === "error");
    out.set(link.id, errors.some((p) => UNSUPPORTED_CODES.has(p.code)) ? "unsupported" : errors.some((p) => !FILE_LEVEL_CODES.has(p.code)) ? "needs-fix" : "blocked");
  }
  return out;
}

/** How many links got each outcome (every outcome named, also at 0). */
export function exportOutcomeCounts(outcomes: ReadonlyMap<string, ExportOutcome>): Record<ExportOutcome, number> {
  const n = Object.fromEntries(EXPORT_OUTCOMES.map((o) => [o, 0])) as Record<ExportOutcome, number>;
  for (const o of outcomes.values()) n[o]++;
  return n;
}

/**
 * The export's accounting (V5 P0-5): every link the project holds is written or held back with a
 * reason, and every deletion of a library record is delivered or held with a reason. Nothing may fall
 * between: a plan that does not add up is a bug, and the export stops rather than drop a link silently.
 */
export function exportAccounting(links: readonly Link[], plan: Pick<ExportPlan, "files" | "written" | "heldBack" | "heldDeletions" | "counts">): string[] {
  const out: string[] = [];
  const live = links.filter((l) => l.status !== "deleted" && l.provenance !== "db");
  const seen = new Map<string, number>();
  for (const l of plan.written) seen.set(l.id, (seen.get(l.id) ?? 0) + 1);
  for (const h of plan.heldBack) {
    seen.set(h.link.id, (seen.get(h.link.id) ?? 0) + 1);
    if (!h.problems.some((p) => p.severity === "error" && p.code && p.message)) out.push(`held without a reason: ${h.link.id}`);
  }
  for (const l of live) if (seen.get(l.id) !== 1) out.push(`${seen.get(l.id) ? "counted twice" : "neither written nor held back"}: ${l.id}`);
  if (seen.size !== live.length) out.push(`${seen.size - live.length} links accounted for that the project does not hold as live`);
  const records = plan.files.reduce((n, f) => n + f.records, 0);
  if (records !== plan.written.length) out.push(`${plan.written.length} links written, ${records} records in the files`);
  const deleted = links.filter((l) => l.status === "deleted" && l.provenance === "file");
  const writtenFiles = new Set(plan.files.map((f) => f.sourceTitle));
  const held = new Set(plan.heldDeletions.map((h) => h.link.id));
  for (const h of plan.heldDeletions) if (!h.problems.some((p) => p.severity === "error" && p.code && p.message)) out.push(`deletion held without a reason: ${h.link.id}`);
  for (const l of deleted) if (writtenFiles.has(l.source.book.title) === held.has(l.id)) out.push(`deletion ${held.has(l.id) ? "both delivered and held" : "neither delivered nor held"}: ${l.id}`);
  if (plan.counts.deleted + plan.counts.deletionsHeld !== deleted.length) out.push(`deletions: ${plan.counts.deleted} + ${plan.counts.deletionsHeld} ≠ ${deleted.length}`);
  return out;
}

function assertExportAccounting(links: readonly Link[], plan: ExportPlan): void {
  const broken = exportAccounting(links, plan);
  if (broken.length)
    throw new LinkerError(
      "export/accounting",
      "הייצוא נעצר: החשבון של הקישורים לא נסגר — יש קישור שלא נכתב ולא הוחזק עם סיבה. זו תקלה בכלי ולא בקישורים שלכם; שמרו את הפרויקט ושלחו אותו עם יומן האבחון.",
      { broken: broken.slice(0, 20) },
    );
}

/**
 * The last line (review C1): a book's file replaces the library's, so it is written only with every
 * record of the library's file the project holds, except the ones the user deleted. validateExport
 * holds such a file whole (export/library-record-held); if a record still falls out, the export stops
 * instead of deleting it from the library.
 */
function assertNoLibraryRecordDropped(links: readonly Link[], written: readonly Link[], bySource: ReadonlyMap<string, readonly Link[]>): void {
  const ids = new Set(written.map((l) => l.id));
  const lost = links.find((l) => l.provenance === "file" && l.status !== "deleted" && bySource.has(l.source.book.title) && !ids.has(l.id));
  if (lost)
    throw new LinkerError(
      "export/library-record-dropped",
      `הייצוא נעצר: קובץ הקישורים של "${lost.source.book.title}" היה נכתב בלי רשומה שיש בקובץ שבספרייה (שורה ${lost.source.line + 1}), והיא הייתה נמחקת מהספרייה. תקנו את הרשומה או מחקו אותה במפורש, ונסו שוב.`,
      { title: lost.source.book.title, id: lost.id },
    );
}

/** Imported records first, in file order; then new ones by source line, target book, target line, type. */
function fileOrder(a: Link, b: Link): number {
  const ai = a.fileIndex ?? Number.POSITIVE_INFINITY;
  const bi = b.fileIndex ?? Number.POSITIVE_INFINITY;
  if (ai !== bi) return ai - bi;
  return (
    a.source.line - b.source.line ||
    cmp(a.target.book.title, b.target.book.title) ||
    a.target.line - b.target.line ||
    cmp(a.declaredType, b.declaredType) ||
    (a.anchor?.rawStart ?? -1) - (b.anchor?.rawStart ?? -1) ||
    cmp(a.id, b.id)
  );
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** One ZIP with every file under links/, as the library lays them out. Deterministic (fixed mtime). */
export function zipExport(plan: ExportPlan): Uint8Array {
  return zipBundle(plan.files.map((f) => ({ path: `links/${f.name}`, text: f.text })));
}

/**
 * A ZIP of text files at the given paths (links/…, alt_toc/…, _report.txt). Deterministic (fixed mtime).
 * Every path must stay inside the archive's folder — the same rule safe-unzip applies to what it
 * reads: no absolute path, drive letter, backslash, empty, "." or ".." segment, NUL or control
 * character. Titles are checked before (export/unsafe-title); this is the last line (A4).
 */
export function zipBundle(entries: readonly { path: string; text: string }[]): Uint8Array {
  assertSafeExportPaths(entries);
  const mtime = new Date("2000-01-01T00:00:00Z");
  return zipSync(Object.fromEntries(entries.map((e) => [e.path, [strToU8(e.text), { mtime }]])), { level: 6 });
}

/** Throws (export/unsafe-path) unless every path is a plain relative path and no two are the same. */
export function assertSafeExportPaths(entries: readonly { path: string }[]): void {
  for (const e of entries)
    if (!isSafeZipPath(e.path)) throw new LinkerError("export/unsafe-path", `קובץ בייצוא קיבל נתיב לא בטוח ("${e.path}"), ולכן הייצוא נעצר. שנו את שם הספר שממנו נגזר הנתיב.`, { path: e.path });
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.path)) throw new LinkerError("export/unsafe-path", `שני קבצים בייצוא קיבלו אותו נתיב ("${e.path}"), ולכן הייצוא נעצר.`, { path: e.path });
    seen.add(e.path);
  }
}

/** NUL, C0 controls and DEL */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A relative path of plain segments, without anything that leaves the folder or that Windows refuses. */
export function isSafeZipPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || CONTROL.test(path) || /^[a-zA-Z]:/.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && !/[<>:"|?*]/.test(seg) && !/[. ]$/.test(seg));
}
