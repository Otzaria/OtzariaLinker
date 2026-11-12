import type { AltTocBook } from "../core/alt-toc/model";
import type { Link } from "../core/links/model";
import type { JsonLayout } from "../formats/links-json/layout";

/*
 * The project's links with undo/redo (stage 14). Pure and immutable: every operation returns a new
 * LinkState, and every user action is ONE Command (a list of per-link before/after pairs), so undo
 * restores exactly what the action changed — including a whole import or a batch approval.
 * Nothing here knows about the UI (architecture rule 8).
 */

export interface Change {
  readonly id: string;
  /** absent = the link did not exist before */
  readonly before?: Link;
  /** absent = the link is removed */
  readonly after?: Link;
}

/** A change of one book's alternative TOC structures (keyed by book title); absent = not in the project. */
export interface AltTocChange {
  readonly title: string;
  readonly before?: AltTocBook;
  readonly after?: AltTocBook;
}

/**
 * A book's links file from the LIBRARY that the project holds (security review A1–A3). Its records are
 * the project's "file" links; the export writes the book's file back as this file plus the user's
 * changes, and it REPLACES the library's file. Part of the undoable state: undoing an import also
 * forgets that the file was loaded.
 */
export interface LibraryFile {
  readonly title: string;
  /** records the file had when loaded */
  readonly records: number;
  /** fingerprint of the file's bytes (fileFingerprint) — recognises the same file when it is loaded again */
  readonly hash: string;
  /**
   * true: loaded from the library in THIS session. false: restored from a saved project — a snapshot
   * that may be old or forged, so the export holds the book until the file is loaded again or the
   * user confirms it (export/file-unverified).
   */
  readonly verified: boolean;
  /** the file's text layout, reused when it is written back (minimal library diff) */
  readonly layout?: JsonLayout;
}

/** A change of one book's library-file record (keyed by title); absent = no file loaded. */
export interface FileChange {
  readonly title: string;
  readonly before?: LibraryFile;
  readonly after?: LibraryFile;
}

export interface Command {
  /** Hebrew, shown in the history list and in the undo tooltip ("יצירת קישור", "ייבוא 120 קישורים") */
  readonly label: string;
  readonly changes: readonly Change[];
  /** alt_toc changes of the same action (alt_toc editing is undoable like links) */
  readonly altToc?: readonly AltTocChange[];
  /** library-file records the same action loaded, replaced or forgot */
  readonly files?: readonly FileChange[];
  readonly at: number;
}

export interface LinkState {
  readonly links: ReadonlyMap<string, Link>;
  /** alternative TOC structures of the project, by book title */
  readonly altToc: ReadonlyMap<string, AltTocBook>;
  /** the library links files the project holds, by book title */
  readonly files: ReadonlyMap<string, LibraryFile>;
  readonly undo: readonly Command[];
  readonly redo: readonly Command[];
  /** bumps on every change; autosave and "unsaved changes" compare against it */
  readonly revision: number;
}

export const HISTORY_LIMIT = 500;

export const emptyLinkState = (): LinkState => ({ links: new Map(), altToc: new Map(), files: new Map(), undo: [], redo: [], revision: 0 });

function applyChanges(links: ReadonlyMap<string, Link>, changes: readonly Change[], dir: "after" | "before"): Map<string, Link> {
  const next = new Map(links);
  for (const c of changes) {
    const v = c[dir];
    if (v) next.set(c.id, v);
    else next.delete(c.id);
  }
  return next;
}

function applyKeyed<T>(books: ReadonlyMap<string, T>, changes: readonly { title: string; before?: T; after?: T }[] | undefined, dir: "after" | "before"): ReadonlyMap<string, T> {
  if (!changes?.length) return books;
  const next = new Map(books);
  for (const c of changes) {
    const v = c[dir];
    if (v) next.set(c.title, v);
    else next.delete(c.title);
  }
  return next;
}

/** Applies a new user action. Empty or no-op changes are dropped and do not create a history entry. */
export function commit(s: LinkState, label: string, changes: readonly Change[], at = Date.now(), altToc: readonly AltTocChange[] = [], files: readonly FileChange[] = []): LinkState {
  const real = changes.filter((c) => c.before !== c.after);
  const realAlt = altToc.filter((c) => c.before !== c.after);
  const realFiles = files.filter((c) => c.before !== c.after);
  if (!real.length && !realAlt.length && !realFiles.length) return s;
  const cmd: Command = { label, changes: real, ...(realAlt.length && { altToc: realAlt }), ...(realFiles.length && { files: realFiles }), at };
  return {
    links: applyChanges(s.links, real, "after"),
    altToc: applyKeyed(s.altToc, realAlt, "after"),
    files: applyKeyed(s.files, realFiles, "after"),
    undo: [...s.undo, cmd].slice(-HISTORY_LIMIT),
    redo: [],
    revision: s.revision + 1,
  };
}

export function undo(s: LinkState): LinkState {
  const cmd = s.undo.at(-1);
  if (!cmd) return s;
  return { links: applyChanges(s.links, cmd.changes, "before"), altToc: applyKeyed(s.altToc, cmd.altToc, "before"), files: applyKeyed(s.files, cmd.files, "before"), undo: s.undo.slice(0, -1), redo: [...s.redo, cmd], revision: s.revision + 1 };
}

export function redo(s: LinkState): LinkState {
  const cmd = s.redo.at(-1);
  if (!cmd) return s;
  return { links: applyChanges(s.links, cmd.changes, "after"), altToc: applyKeyed(s.altToc, cmd.altToc, "after"), files: applyKeyed(s.files, cmd.files, "after"), undo: [...s.undo, cmd], redo: s.redo.slice(0, -1), revision: s.revision + 1 };
}

/**
 * Re-points links at books without making an action: `fix` returns the link with its books resolved
 * (or the same object). Applied to the current links AND to every version the history holds, so undo
 * and redo bring back resolved links too. Not a user change: no history entry, no new revision
 * (product audit F6: links loaded before their books are attached when the books open).
 */
export function rebindLinks(s: LinkState, fix: (l: Link) => Link): LinkState {
  let changed = false;
  const f = (l: Link): Link => {
    const n = fix(l);
    if (n !== l) changed = true;
    return n;
  };
  const cmd = (c: Command): Command => {
    let touched = false;
    const changes = c.changes.map((x) => {
      const before = x.before && f(x.before);
      const after = x.after && f(x.after);
      if (before === x.before && after === x.after) return x;
      touched = true;
      return { id: x.id, ...(before && { before }), ...(after && { after }) };
    });
    return touched ? { ...c, changes } : c;
  };
  const links = new Map<string, Link>();
  for (const [id, l] of s.links) links.set(id, f(l));
  const undo = s.undo.map(cmd);
  const redo = s.redo.map(cmd);
  return changed ? { ...s, links, undo, redo } : s;
}

/** Setting (or, with null, dropping) one book's structures, as a change. */
export function altTocChange(s: LinkState, title: string, after: AltTocBook | null): AltTocChange {
  const before = s.altToc.get(title);
  return { title, ...(before && { before }), ...(after && { after }) };
}

/** Setting (or, with null, forgetting) one book's library-file record, as a change. */
export function fileChange(s: LinkState, title: string, after: LibraryFile | null): FileChange {
  const before = s.files.get(title);
  return { title, ...(before && { before }), ...(after && { after }) };
}

/**
 * A fingerprint of a file's text: 53-bit cyrb53 over UTF-16 code units, as hex, with the length.
 * Not a security hash — it only recognises the same file when it is loaded again; trust comes from
 * comparing the records themselves (store.exchange.importLinksFile).
 */
export function fileFingerprint(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length.toString(36)}-${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)}`;
}

/* ---- the link operations users perform, expressed as Changes ---- */

export const addChanges = (links: readonly Link[]): Change[] => links.map((l) => ({ id: l.id, after: l }));

/** Editing an imported link marks it "edited"; a new link stays "new". */
export function editChange(s: LinkState, id: string, patch: Partial<Omit<Link, "id" | "provenance">>): Change | null {
  const before = s.links.get(id);
  if (!before || before.provenance === "db") return null;
  const status = before.status === "existing" ? "edited" : before.status;
  return { id, before, after: { ...before, ...patch, status: patch.status ?? status } };
}

/** Deleting a link the user created removes it; deleting an imported one marks it for deletion on export. */
export function deleteChange(s: LinkState, id: string): Change | null {
  const before = s.links.get(id);
  if (!before || before.provenance === "db") return null;
  if (before.status === "new") return { id, before };
  return { id, before, after: { ...before, status: "deleted" } };
}

export function restoreChange(s: LinkState, id: string): Change | null {
  const before = s.links.get(id);
  if (!before || before.status !== "deleted") return null;
  return { id, before, after: { ...before, status: before.keyOrder ? "edited" : "new" } };
}

/* ---- the history list (v3 "היסטוריית פעולות") ---- */

export interface HistoryEntry {
  readonly label: string;
  readonly at: number;
  /** how many links and alt_toc books the action changed */
  readonly changes: number;
  /** the history position right after this action: going "to" the entry applies it and everything before it */
  readonly position: number;
  /** false for an action that was undone and can be redone */
  readonly applied: boolean;
}

/** The current position: how many actions of the timeline are applied (0 = none). */
export const historyPosition = (s: LinkState): number => s.undo.length;

/** Every action the history holds, oldest first: the applied ones, then the undone ones in redo order. */
export function timeline(s: LinkState): HistoryEntry[] {
  const all = [...s.undo, ...[...s.redo].reverse()];
  return all.map((c, i) => ({ label: c.label, at: c.at, changes: c.changes.length + (c.altToc?.length ?? 0) + (c.files?.length ?? 0), position: i + 1, applied: i < s.undo.length }));
}

/** Undoes or redoes, one action at a time, until `position` actions are applied. */
export function travel(s: LinkState, position: number): LinkState {
  const total = s.undo.length + s.redo.length;
  const to = Math.max(0, Math.min(total, Math.floor(position)));
  let next = s;
  while (next.undo.length > to) next = undo(next);
  while (next.undo.length < to) next = redo(next);
  return next;
}

/** "קישור אחד" / "12 קישורים" — counts in action labels. */
export const linksCount = (n: number): string => (n === 1 ? "קישור אחד" : `${n.toLocaleString("he")} קישורים`);
