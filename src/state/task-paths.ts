/*
 * The home screen's paths (issue 20, V7 §3.1): one card per goal of the user — link books, a repository (analyse and
 * complete), check and fix links, continue a project. Three of them ask a first question inside the wizard ("what do you
 * want to link?"); the tasks themselves (ui/screens/home.tsx TASKS) and their routes `#/start/<id>` are unchanged, so old
 * addresses keep working and nothing is removed — only where the choice is made moved.
 *
 * No two choices do the same thing (#20): a commentary and a notes book are one choice whose sheet asks which the second
 * book is, and several books and a folder against Otzaria are one guided flow. The other answer of such a choice is a
 * VARIANT: still a task and a route, reached from the choice it belongs to.
 */

/** A path that asks which task before it asks for sources. `id` is also a route: `#/start/<id>`. */
export const TASK_PATHS = [
  { id: "auto", choose: ["commentary", "citations", "folder-otzaria", "manual"] },
  { id: "repo", choose: ["analyze", "db-db", "within-db", "db-links", "coverage"] },
  { id: "fix", choose: ["edit-links", "relink"] },
] as const;

/** A task that is its own card (none now: manual linking is a way to link books, and is chosen there). */
export const DIRECT_TASKS: readonly string[] = [];

/** The other answer of a choice → the choice that offers it. */
export const TASK_VARIANTS: Readonly<Record<string, string>> = { notes: "commentary", several: "folder-otzaria" };

/** The choice a task belongs to: itself, or the choice it is a variant of. A sheet keeps its state across the variants of one group. */
export const variantGroup = (taskId: string): string => TASK_VARIANTS[taskId] ?? taskId;

/** The home cards, in order. "project" opens a saved project file directly (no task). */
export const HOME_CARDS = ["auto", "repo", "fix", "project"] as const;

export type PathId = (typeof TASK_PATHS)[number]["id"];

export const isPathId = (id: string | null | undefined): id is PathId => TASK_PATHS.some((p) => p.id === id);

/** The path that chooses a task (or the choice it is a variant of), if any: the sheet's "back to the choice". */
export const pathOfTask = (taskId: string): PathId | undefined => TASK_PATHS.find((p) => (p.choose as readonly string[]).includes(variantGroup(taskId)))?.id;
