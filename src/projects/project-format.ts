import type { BookOrigin, BookRef, Link, LinkSide } from "../core/links/model";

/*
 * The saved project (stage 14): a portable JSON file. It never holds book text or file handles —
 * a browser cannot reopen a file by itself after closing — only what the user DID: links (new,
 * edited, imported, marked for deletion), rejected suggestions, and which sources were open, so
 * reopening can ask for the same files again and re-bind every link to its book by exact title.
 *
 * Book keys inside a session ("s3:1234") are not stable across sessions, so links are stored with
 * book TITLES and bound again on load. "format" is the first key: the file detector looks for it
 * in the first KiB.
 */
export const PROJECT_FORMAT = "otzaria-linker-project";
export const PROJECT_VERSION = 1;

export interface ProjectSource {
  label: string;
  kind: string;
  books: number;
}

interface StoredBook {
  title: string;
  origin: BookOrigin;
  isBaseBook?: boolean;
}
interface StoredSide {
  book: StoredBook;
  line: number;
  end?: number;
}
type StoredLink = Omit<Link, "source" | "target"> & { source: StoredSide; target: StoredSide };

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: number;
  savedAt: string;
  app: string;
  sources: ProjectSource[];
  links: StoredLink[];
  rejectedSuggestions: string[];
  view: { source: string | null; target: string | null };
}

export interface ProjectData {
  sources: ProjectSource[];
  links: Link[];
  rejectedSuggestions: string[];
  /** book titles shown when saved */
  view: { source: string | null; target: string | null };
}

const storeSide = (s: LinkSide): StoredSide => ({
  book: { title: s.book.title, origin: s.book.origin, ...(s.book.isBaseBook !== undefined && { isBaseBook: s.book.isBaseBook }) },
  line: s.line,
  ...(s.end !== undefined && { end: s.end }),
});

export function serializeProject(p: ProjectData, app: string, now = new Date()): string {
  const file: ProjectFile = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: now.toISOString(),
    app,
    sources: p.sources,
    // database links are never part of a project: they are read again from the database
    links: p.links.filter((l) => l.provenance !== "db").map((l) => ({ ...l, source: storeSide(l.source), target: storeSide(l.target) })),
    rejectedSuggestions: p.rejectedSuggestions,
    view: p.view,
  };
  return JSON.stringify(file);
}

export class ProjectError extends Error {
  constructor(readonly code: "project/not-json" | "project/not-a-project" | "project/newer" | "project/corrupt", message: string) {
    super(message);
  }
}

/** Parses and validates a project file; `bind` turns a stored book back into a BookRef of this session. */
export function parseProject(text: string, bind: (b: StoredBook) => BookRef): ProjectData & { savedAt: string; skipped: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProjectError("project/not-json", "הקובץ אינו JSON תקין, ולכן אינו פרויקט שמור.");
  }
  const f = raw as Partial<ProjectFile>;
  if (!f || f.format !== PROJECT_FORMAT) throw new ProjectError("project/not-a-project", "הקובץ אינו פרויקט של מנהל הקישורים.");
  if (typeof f.version !== "number" || f.version > PROJECT_VERSION)
    throw new ProjectError("project/newer", "הפרויקט נשמר בגרסה חדשה יותר של הכלי. עדכנו את הכלי ונסו שוב.");
  if (!Array.isArray(f.links)) throw new ProjectError("project/corrupt", "בפרויקט חסרה רשימת הקישורים.");

  const links: Link[] = [];
  let skipped = 0;
  for (const l of f.links) {
    if (!isStoredLink(l)) {
      skipped++;
      continue;
    }
    links.push({ ...l, source: { ...l.source, book: bind(l.source.book) }, target: { ...l.target, book: bind(l.target.book) } } as Link);
  }
  return {
    savedAt: typeof f.savedAt === "string" ? f.savedAt : "",
    sources: Array.isArray(f.sources) ? f.sources.filter((s) => s && typeof s.label === "string") : [],
    links,
    rejectedSuggestions: Array.isArray(f.rejectedSuggestions) ? f.rejectedSuggestions.filter((x) => typeof x === "string") : [],
    view: { source: typeof f.view?.source === "string" ? f.view.source : null, target: typeof f.view?.target === "string" ? f.view.target : null },
    skipped,
  };
}

const STATUSES = new Set(["new", "edited", "existing", "deleted"]);
const PROVENANCES = new Set(["file", "user", "auto"]);
const isInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;
const isSide = (s: unknown): s is StoredSide => {
  const v = s as StoredSide;
  return !!v && typeof v.book?.title === "string" && isInt(v.line) && (v.end === undefined || isInt(v.end));
};
function isStoredLink(x: unknown): x is StoredLink {
  const l = x as StoredLink;
  return (
    !!l && typeof l.id === "string" && STATUSES.has(l.status) && PROVENANCES.has(l.provenance) &&
    isSide(l.source) && isSide(l.target) && typeof l.declaredType === "string" && typeof l.heRef2 === "string"
  );
}
