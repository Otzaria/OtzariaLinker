import { zipSync, strToU8 } from "fflate";
import { LinkerError } from "../../core/errors";
import type { Link } from "../../core/links/model";
import { unsafeFileTitle } from "../../core/links/titles";
import { FILE_LEVEL_CODES, validateExport, type Problem, type ValidationContext } from "../../core/links/validate";
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
 *   • a link with an error is held back (never written silently) and listed with its reasons.
 */
export interface ExportFile {
  /** file name inside the export ("<source title>_links.json") */
  name: string;
  sourceTitle: string;
  text: string;
  records: number;
  /** true when no links file was imported for this book — the library may already have one */
  isNewFile: boolean;
}

export interface ExportPlan {
  files: ExportFile[];
  written: Link[];
  heldBack: { link: Link; problems: Problem[] }[];
  warned: { link: Link; problems: Problem[] }[];
  counts: { new: number; edited: number; kept: number; deleted: number; heldBack: number; files: number };
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
    const p = problems.get(l.id) ?? [];
    // An imported record the user did not touch is already in the library: dropping it from the
    // rewritten file would DELETE it there. It is kept as it was, with its problems as warnings.
    const untouchedImport = l.provenance === "file" && l.status === "existing";
    // a problem of the book's whole file holds it back always — also untouched and in expert mode (A1–A4)
    const fileHeld = p.some((x) => FILE_LEVEL_CODES.has(x.code));
    if (fileHeld || (!opts.includeErrors && !untouchedImport && p.some((x) => x.severity === "error"))) heldBack.push({ link: l, problems: p });
    else {
      written.push(l);
      if (p.some((x) => x.severity === "warning" || x.severity === "error")) warned.push({ link: l, problems: p });
    }
  }

  const bySource = new Map<string, Link[]>();
  // push, not spread: one book's file can hold 100k+ records (the library's largest has 112,905),
  // and copying the list for every link made planning quadratic — 259 s for that one file
  for (const l of written) {
    const list = bySource.get(l.source.book.title);
    if (list) list.push(l);
    else bySource.set(l.source.book.title, [l]);
  }
  const importedTitles = new Set(links.filter((l) => l.provenance === "file").map((l) => l.source.book.title));
  const heldTitles = new Set(heldBack.filter((h) => h.problems.some((x) => FILE_LEVEL_CODES.has(x.code))).map((h) => h.link.source.book.title));

  // A book whose imported links were ALL deleted still needs its file — empty — or the library's
  // old file would stay and the deletions would never happen (compatibility review #2).
  for (const title of importedTitles) if (!bySource.has(title) && !heldTitles.has(title) && !unsafeFileTitle(title)) bySource.set(title, []);

  const files: ExportFile[] = [...bySource.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([title, list]) => {
      const ordered = [...list].sort(fileOrder);
      return {
        name: `${title}_links.json`,
        sourceTitle: title,
        text: serializeLinksJson(ordered.map(linkToRecord), opts.layouts?.(title)),
        records: ordered.length,
        isNewFile: !importedTitles.has(title) && !opts.loadedFile?.(title),
      };
    });

  return {
    files,
    written,
    heldBack,
    warned,
    counts: {
      new: written.filter((l) => l.status === "new").length,
      edited: written.filter((l) => l.status === "edited").length,
      kept: written.filter((l) => l.status === "existing").length,
      deleted: links.filter((l) => l.status === "deleted" && l.provenance === "file").length,
      heldBack: heldBack.length,
      files: files.length,
    },
  };
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
