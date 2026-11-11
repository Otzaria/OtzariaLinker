import { zipSync, strToU8 } from "fflate";
import type { Link } from "../../core/links/model";
import { storedKey } from "../../core/links/stored-form";
import { validateExport, type Problem, type ValidationContext } from "../../core/links/validate";
import { linkToRecord } from "./convert";
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
}

export function planExport(links: readonly Link[], ctx: ValidationContext, opts: ExportOptions = {}): ExportPlan {
  const live = links.filter((l) => l.status !== "deleted" && l.provenance !== "db");
  const problems = validateExport(live, ctx, storedKey);
  const written: Link[] = [];
  const heldBack: ExportPlan["heldBack"] = [];
  const warned: ExportPlan["warned"] = [];
  for (const l of live) {
    const p = problems.get(l.id) ?? [];
    if (!opts.includeErrors && p.some((x) => x.severity === "error")) heldBack.push({ link: l, problems: p });
    else {
      written.push(l);
      if (p.some((x) => x.severity === "warning")) warned.push({ link: l, problems: p });
    }
  }

  const bySource = new Map<string, Link[]>();
  for (const l of written) bySource.set(l.source.book.title, [...(bySource.get(l.source.book.title) ?? []), l]);
  const importedTitles = new Set(links.filter((l) => l.provenance === "file").map((l) => l.source.book.title));

  const files: ExportFile[] = [...bySource.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([title, list]) => {
      const ordered = [...list].sort(fileOrder);
      return {
        name: `${title}_links.json`,
        sourceTitle: title,
        text: serializeLinksJson(ordered.map(linkToRecord)),
        records: ordered.length,
        isNewFile: !importedTitles.has(title),
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
  const mtime = new Date("2000-01-01T00:00:00Z");
  return zipSync(Object.fromEntries(plan.files.map((f) => [`links/${f.name}`, [strToU8(f.text), { mtime }]])), { level: 6 });
}
