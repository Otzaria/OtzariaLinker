import { validateAltToc, writtenStructures, type AltTocBook, type AltTocContext, type AltTocProblem } from "../../core/alt-toc/model";
import { altTocFileName, serializeAltToc } from "./file";

/*
 * Which alt_toc files the export writes. The file REPLACES every structure of its book in the
 * library (keys it does not declare are deleted), so a book is written whole or not at all: one
 * error holds the whole book back rather than writing a file that would silently drop the rest.
 */
export interface AltTocExportFile {
  /** "<title>_alt_toc.json"; inside a ZIP it goes under alt_toc/ */
  name: string;
  title: string;
  text: string;
  structures: number;
  nodes: number;
  /** warnings and notes — the file is written anyway */
  problems: AltTocProblem[];
  /** written as "[]": the book's structures were all removed, and the file removes them from the library */
  clears: boolean;
}

export interface AltTocExportPlan {
  files: AltTocExportFile[];
  heldBack: { title: string; problems: AltTocProblem[] }[];
}

export function planAltTocExport(books: readonly AltTocBook[], ctxOf: (title: string) => AltTocContext): AltTocExportPlan {
  const files: AltTocExportFile[] = [];
  const heldBack: AltTocExportPlan["heldBack"] = [];
  for (const b of [...books].sort((x, y) => (x.title < y.title ? -1 : x.title > y.title ? 1 : 0))) {
    const written = writtenStructures(b.structures);
    // a list the user started and emptied again was never in the library: nothing to write
    if (!written.length && b.origin === "user") continue;
    const problems = validateAltToc(b.structures, ctxOf(b.title));
    if (problems.some((p) => p.severity === "error")) {
      heldBack.push({ title: b.title, problems });
      continue;
    }
    files.push({
      name: altTocFileName(b.title),
      title: b.title,
      text: serializeAltToc(b.structures),
      structures: written.length,
      nodes: written.reduce((n, s) => n + s.entries.length, 0),
      problems,
      clears: !written.length,
    });
  }
  return { files, heldBack };
}
