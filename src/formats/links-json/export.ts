import { zipSync, strToU8 } from "fflate";
import { LinkerError } from "../../core/errors";
import type { Link } from "../../core/links/model";
import { unsafeFileTitle } from "../../core/links/titles";
import { asExported, FILE_LEVEL_CODES, PRIVATE_TO_BASE, privateSourceRecord, validateExport, type Problem, type ValidationContext } from "../../core/links/validate";
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
 *     PRIVATE_TO_BASE: Otzaria's personal import does not reverse "source"), and the plan says which file.
 */
export interface ExportFile {
  /** file name inside the export ("<source title>_links.json") */
  name: string;
  sourceTitle: string;
  text: string;
  records: number;
  /** true when no links file was imported for this book — the library may already have one */
  isNewFile: boolean;
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
  /** private use: link id → the record written for it in another book's file (a "source" link at its base) */
  moved: ReadonlyMap<string, Link>;
  counts: { new: number; edited: number; kept: number; deleted: number; heldBack: number; files: number; movedToBase: number };
}

export interface ExportOptions {
  /** also write links with errors (expert mode) — default false */
  includeErrors?: boolean;
  /** the text layout of each book's imported file (formats/links-json/layout.ts); new files get the default */
  layouts?: (sourceTitle: string) => JsonLayout | undefined;
  /** the book's library file was loaded (it may hold no records): its file is not "new" */
  loadedFile?: (sourceTitle: string) => boolean;
}

export function planExport(links: readonly Link[], ctx: ValidationContext, opts: ExportOptions = {}): ExportPlan {
  const live = links.filter((l) => l.status !== "deleted" && l.provenance !== "db");
  const problems = validateExport(live, ctx);
  const written: Link[] = [];
  const heldBack: ExportPlan["heldBack"] = [];
  const warned: ExportPlan["warned"] = [];
  for (const l of live) {
    // An imported record the user did not touch is kept as it was, its errors as warnings (asExported:
    // the same rule the quality check reports by)
    const p = asExported(l, problems.get(l.id) ?? []);
    // a problem of the book's whole file holds it back always — also untouched and in expert mode (A1–A4)
    const fileHeld = p.some((x) => FILE_LEVEL_CODES.has(x.code));
    if (fileHeld || (!opts.includeErrors && p.some((x) => x.severity === "error"))) heldBack.push({ link: l, problems: p });
    else {
      written.push(l);
      if (p.some((x) => x.severity === "warning" || x.severity === "error")) warned.push({ link: l, problems: p });
    }
  }

  const bySource = new Map<string, Link[]>();
  /** file title → the book each moved record came from → how many */
  const movedIn = new Map<string, Map<string, number>>();
  const moved = new Map<string, Link>();
  // push, not spread: one book's file can hold 100k+ records (the library's largest has 112,905),
  // and copying the list for every link made planning quadratic — 259 s for that one file
  for (const l of written) {
    // private use: a "source" link goes into its base's file, as the validation said (PRIVATE_TO_BASE)
    const atBase = problems.get(l.id)?.some((p) => p.code === PRIVATE_TO_BASE) ? privateSourceRecord(l) : null;
    const record = atBase ?? l;
    if (atBase) {
      moved.set(l.id, atBase);
      const from = movedIn.get(atBase.source.book.title) ?? new Map<string, number>();
      from.set(l.source.book.title, (from.get(l.source.book.title) ?? 0) + 1);
      movedIn.set(atBase.source.book.title, from);
    }
    const list = bySource.get(record.source.book.title);
    if (list) list.push(record);
    else bySource.set(record.source.book.title, [record]);
  }
  const importedTitles = new Set(links.filter((l) => l.provenance === "file").map((l) => l.source.book.title));
  const heldTitles = new Set(heldBack.filter((h) => h.problems.some((x) => FILE_LEVEL_CODES.has(x.code))).map((h) => h.link.source.book.title));

  // A book whose imported links were ALL deleted still needs its file — empty — or the library's
  // old file would stay and the deletions would never happen (compatibility review #2).
  for (const title of importedTitles) if (!bySource.has(title) && !heldTitles.has(title) && !unsafeFileTitle(title)) bySource.set(title, []);

  assertNoLibraryRecordDropped(links, written, bySource);

  const files: ExportFile[] = [...bySource.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([title, list]) => {
      const ordered = [...list].sort(fileOrder);
      const from = movedIn.get(title);
      return {
        name: `${title}_links.json`,
        sourceTitle: title,
        text: serializeLinksJson(ordered.map(linkToRecord), opts.layouts?.(title)),
        records: ordered.length,
        isNewFile: !importedTitles.has(title) && !opts.loadedFile?.(title),
        ...(from && { movedIn: [...from].sort(([a], [b]) => cmp(a, b)).map(([t, records]) => ({ from: t, records })) }),
      };
    });

  return {
    files,
    written,
    heldBack,
    warned,
    moved,
    counts: {
      new: written.filter((l) => l.status === "new").length,
      edited: written.filter((l) => l.status === "edited").length,
      kept: written.filter((l) => l.status === "existing").length,
      deleted: links.filter((l) => l.status === "deleted" && l.provenance === "file").length,
      heldBack: heldBack.length,
      files: files.length,
      movedToBase: moved.size,
    },
  };
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
