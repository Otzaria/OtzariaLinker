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

export interface Command {
  /** Hebrew, shown in the history list and in the undo tooltip ("יצירת קישור", "ייבוא 120 קישורים") */
  readonly label: string;
  readonly changes: readonly Change[];
  readonly at: number;
}

export interface LinkState {
  readonly links: ReadonlyMap<string, Link>;
  readonly undo: readonly Command[];
  readonly redo: readonly Command[];
  /** bumps on every change; autosave and "unsaved changes" compare against it */
  readonly revision: number;
}

export const HISTORY_LIMIT = 500;

export const emptyLinkState = (): LinkState => ({ links: new Map(), undo: [], redo: [], revision: 0 });

function applyChanges(links: ReadonlyMap<string, Link>, changes: readonly Change[], dir: "after" | "before"): Map<string, Link> {
  const next = new Map(links);
  for (const c of changes) {
    const v = c[dir];
    if (v) next.set(c.id, v);
    else next.delete(c.id);
  }
  return next;
}

/** Applies a new user action. Empty or no-op changes are dropped and do not create a history entry. */
export function commit(s: LinkState, label: string, changes: readonly Change[], at = Date.now()): LinkState {
  const real = changes.filter((c) => c.before !== c.after);
  if (!real.length) return s;
  const cmd: Command = { label, changes: real, at };
  return {
    links: applyChanges(s.links, real, "after"),
    undo: [...s.undo, cmd].slice(-HISTORY_LIMIT),
    redo: [],
    revision: s.revision + 1,
  };
}

export function undo(s: LinkState): LinkState {
  const cmd = s.undo.at(-1);
  if (!cmd) return s;
  return { links: applyChanges(s.links, cmd.changes, "before"), undo: s.undo.slice(0, -1), redo: [...s.redo, cmd], revision: s.revision + 1 };
}

export function redo(s: LinkState): LinkState {
  const cmd = s.redo.at(-1);
  if (!cmd) return s;
  return { links: applyChanges(s.links, cmd.changes, "after"), undo: [...s.undo, cmd], redo: s.redo.slice(0, -1), revision: s.revision + 1 };
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
  /** how many links the action changed */
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
  return all.map((c, i) => ({ label: c.label, at: c.at, changes: c.changes.length, position: i + 1, applied: i < s.undo.length }));
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
