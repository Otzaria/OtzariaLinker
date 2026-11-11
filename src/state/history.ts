import type { AltTocBook } from "../core/alt-toc/model";
import type { Link } from "../core/links/model";

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

export interface Command {
  /** Hebrew, shown in the history list and in the undo tooltip ("יצירת קישור", "ייבוא 120 קישורים") */
  readonly label: string;
  readonly changes: readonly Change[];
  /** alt_toc changes of the same action (alt_toc editing is undoable like links) */
  readonly altToc?: readonly AltTocChange[];
  readonly at: number;
}

export interface LinkState {
  readonly links: ReadonlyMap<string, Link>;
  /** alternative TOC structures of the project, by book title */
  readonly altToc: ReadonlyMap<string, AltTocBook>;
  readonly undo: readonly Command[];
  readonly redo: readonly Command[];
  /** bumps on every change; autosave and "unsaved changes" compare against it */
  readonly revision: number;
}

export const HISTORY_LIMIT = 500;

export const emptyLinkState = (): LinkState => ({ links: new Map(), altToc: new Map(), undo: [], redo: [], revision: 0 });

function applyChanges(links: ReadonlyMap<string, Link>, changes: readonly Change[], dir: "after" | "before"): Map<string, Link> {
  const next = new Map(links);
  for (const c of changes) {
    const v = c[dir];
    if (v) next.set(c.id, v);
    else next.delete(c.id);
  }
  return next;
}

function applyAltToc(books: ReadonlyMap<string, AltTocBook>, changes: readonly AltTocChange[] | undefined, dir: "after" | "before"): ReadonlyMap<string, AltTocBook> {
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
export function commit(s: LinkState, label: string, changes: readonly Change[], at = Date.now(), altToc: readonly AltTocChange[] = []): LinkState {
  const real = changes.filter((c) => c.before !== c.after);
  const realAlt = altToc.filter((c) => c.before !== c.after);
  if (!real.length && !realAlt.length) return s;
  const cmd: Command = { label, changes: real, ...(realAlt.length && { altToc: realAlt }), at };
  return {
    links: applyChanges(s.links, real, "after"),
    altToc: applyAltToc(s.altToc, realAlt, "after"),
    undo: [...s.undo, cmd].slice(-HISTORY_LIMIT),
    redo: [],
    revision: s.revision + 1,
  };
}

export function undo(s: LinkState): LinkState {
  const cmd = s.undo.at(-1);
  if (!cmd) return s;
  return { links: applyChanges(s.links, cmd.changes, "before"), altToc: applyAltToc(s.altToc, cmd.altToc, "before"), undo: s.undo.slice(0, -1), redo: [...s.redo, cmd], revision: s.revision + 1 };
}

export function redo(s: LinkState): LinkState {
  const cmd = s.redo.at(-1);
  if (!cmd) return s;
  return { links: applyChanges(s.links, cmd.changes, "after"), altToc: applyAltToc(s.altToc, cmd.altToc, "after"), undo: [...s.undo, cmd], redo: s.redo.slice(0, -1), revision: s.revision + 1 };
}

/** Setting (or, with null, dropping) one book's structures, as a change. */
export function altTocChange(s: LinkState, title: string, after: AltTocBook | null): AltTocChange {
  const before = s.altToc.get(title);
  return { title, ...(before && { before }), ...(after && { after }) };
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
