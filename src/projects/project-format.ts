import type { AltTocBook, AltTocEntry, AltTocOrigin, AltTocStructure } from "../core/alt-toc/model";
import { parseSavedDbMappings, type SavedDbMapping } from "../core/db-mapping";
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
 *
 * `altToc` (alternative TOC structures, by book title) was added later as an OPTIONAL field of
 * version 1: older project files simply have none, and nothing else changed.
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
  altToc?: AltTocBook[];
  /**
   * Optional (added in 2.0 without a version bump: older readers ignore it): how databases in
   * someone else's schema were mapped, by schema fingerprint, so reopening one skips the wizard.
   */
  dbMappings?: SavedDbMapping[];
}

export interface ProjectData {
  sources: ProjectSource[];
  links: Link[];
  rejectedSuggestions: string[];
  /** book titles shown when saved */
  view: { source: string | null; target: string | null };
  /** alternative TOC structures of the project (absent in files saved before they existed) */
  altToc?: AltTocBook[];
  dbMappings?: SavedDbMapping[];
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
    ...(p.altToc?.length && { altToc: p.altToc }),
    ...(p.dbMappings?.length && { dbMappings: p.dbMappings }),
  };
  return JSON.stringify(file);
}

export class ProjectError extends Error {
  constructor(readonly code: "project/not-json" | "project/not-a-project" | "project/newer" | "project/corrupt", message: string) {
    super(message);
  }
}

/** Parses and validates a project file; `bind` turns a stored book back into a BookRef of this session. */
export function parseProject(text: string, bind: (b: StoredBook) => BookRef): ProjectData & { altToc: AltTocBook[]; savedAt: string; skipped: number } {
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
  const altToc = rebuildAltToc(f.altToc);
  for (const l of f.links) {
    const link = isStoredLink(l) ? rebuildLink(l, bind) : null;
    if (link) links.push(link);
    else skipped++;
  }
  return {
    savedAt: typeof f.savedAt === "string" ? f.savedAt : "",
    sources: Array.isArray(f.sources) ? f.sources.filter((s) => s && typeof s.label === "string") : [],
    links,
    rejectedSuggestions: Array.isArray(f.rejectedSuggestions) ? f.rejectedSuggestions.filter((x) => typeof x === "string") : [],
    view: { source: typeof f.view?.source === "string" ? f.view.source : null, target: typeof f.view?.target === "string" ? f.view.target : null },
    altToc: altToc.books,
    dbMappings: parseSavedDbMappings(f.dbMappings),
    skipped: skipped + altToc.skipped,
  };
}

/* ---- alt_toc: rebuilt field by field, like links (untrusted input) ---- */
const ALT_ORIGINS = new Set<AltTocOrigin>(["user", "file", "db"]);
function rebuildAltToc(raw: unknown): { books: AltTocBook[]; skipped: number } {
  if (!Array.isArray(raw)) return { books: [], skipped: 0 };
  const books: AltTocBook[] = [];
  const titles = new Set<string>();
  let skipped = 0;
  for (const b of raw as Record<string, unknown>[]) {
    if (!b || typeof b !== "object" || !str(b.title) || titles.has(b.title) || !Array.isArray(b.structures)) {
      skipped++;
      continue;
    }
    const structures: AltTocStructure[] = [];
    for (const s of b.structures as Record<string, unknown>[]) {
      const entries = s && Array.isArray(s.entries) ? (s.entries as Record<string, unknown>[]).filter(isEntry).map((e): AltTocEntry => ({ heTitle: e.heTitle as string, line: e.line as number, level: e.level as number })) : null;
      if (!s || !str(s.key) || !entries || entries.length !== (s.entries as unknown[]).length) {
        skipped++;
        continue;
      }
      structures.push({ key: s.key, ...(str(s.title) && { title: s.title }), ...(str(s.heTitle) && { heTitle: s.heTitle }), entries });
    }
    titles.add(b.title);
    books.push({ title: b.title, origin: ALT_ORIGINS.has(b.origin as AltTocOrigin) ? (b.origin as AltTocOrigin) : "user", structures });
  }
  return { books, skipped };
}
const isEntry = (e: Record<string, unknown>): boolean => !!e && typeof e === "object" && str(e.heTitle) && Number.isInteger(e.line) && Number.isInteger(e.level);

/*
 * A project file is untrusted input (it may also come from the browser's autosave, which other local
 * pages can write). Links are REBUILT field by field from checked values — nothing is spread from
 * the file — so an odd field can neither crash the export later nor alias another book (review #9).
 */
const ORIGINS = new Set<BookOrigin>(["otzaria", "sefaria", "personal", "unknown"]);
const str = (x: unknown): x is string => typeof x === "string";
function rebuildLink(l: StoredLink, bind: (b: StoredBook) => BookRef): Link | null {
  const book = (b: StoredBook): StoredBook => ({ title: b.title, origin: ORIGINS.has(b.origin) ? b.origin : "unknown", ...(typeof b.isBaseBook === "boolean" && { isBaseBook: b.isBaseBook }) });
  const side = (s: StoredSide) => ({ book: bind(book(s.book)), line: s.line, ...(s.end !== undefined && { end: s.end }) });
  const a = l.anchor as unknown as Record<string, unknown> | undefined;
  if (a !== undefined && (!a || !isInt(a.rawStart) || (a.rawEnd !== undefined && !isInt(a.rawEnd)) || (a.label !== undefined && !str(a.label)))) return null;
  if (l.keyOrder !== undefined && !(Array.isArray(l.keyOrder) && l.keyOrder.every(str))) return null;
  const pass = l.passthrough as unknown;
  if (pass !== undefined && (typeof pass !== "object" || pass === null || Array.isArray(pass))) return null;
  return {
    id: l.id,
    status: l.status,
    provenance: l.provenance,
    source: side(l.source),
    target: side(l.target),
    declaredType: l.declaredType,
    heRef2: l.heRef2,
    ...(str(l.ref1) && { ref1: l.ref1 }),
    ...(str(l.ref2) && { ref2: l.ref2 }),
    ...(a && { anchor: { rawStart: a.rawStart as number, ...(a.rawEnd !== undefined && { rawEnd: a.rawEnd as number }), ...(a.label !== undefined && { label: a.label as string }), ...(str(a.contentHash) && { contentHash: a.contentHash }) } }),
    ...(pass !== undefined && { passthrough: copyData(pass as Record<string, unknown>) }),
    ...(l.keyOrder !== undefined && { keyOrder: [...l.keyOrder] }),
    ...(l.typeNull === true && { typeNull: true }),
    ...(str(l.targetPath) && { targetPath: l.targetPath }),
    ...(isInt(l.fileIndex) && { fileIndex: l.fileIndex }),
  };
}
function copyData(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) Object.defineProperty(out, k, { value: o[k], enumerable: true, writable: true, configurable: true });
  return out;
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
