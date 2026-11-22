/*
 * The home screen's paths (issue 20). Ten task cards became five: automatic linking, manual linking, analysis of a
 * repository, check-fix-merge, and opening a project. Three of them ask a first question inside the wizard ("what do you
 * want to link?"); the tasks themselves (ui/screens/home.tsx TASKS) and their routes `#/start/<id>` are unchanged, so old
 * addresses keep working and nothing is removed — only where the choice is made moved.
 */

/** A path that asks which task before it asks for sources. `id` is also a route: `#/start/<id>`. */
export const TASK_PATHS = [
  { id: "auto", choose: ["commentary", "notes", "citations", "several", "folder-otzaria"] },
  { id: "repo", choose: ["db-db", "within-db", "db-links", "coverage"] },
  { id: "fix", choose: ["edit-links", "relink"] },
] as const;

/** A task that is its own card. */
export const DIRECT_TASKS: readonly string[] = ["manual"];

/** The home cards, in order. "project" opens a saved project file directly (no task). */
export const HOME_CARDS = ["auto", "manual", "repo", "fix", "project"] as const;

export type PathId = (typeof TASK_PATHS)[number]["id"];

export const isPathId = (id: string | null | undefined): id is PathId => TASK_PATHS.some((p) => p.id === id);

/** The path that chooses a task, if any (the sheet's "back to the choice"). */
export const pathOfTask = (taskId: string): PathId | undefined => TASK_PATHS.find((p) => (p.choose as readonly string[]).includes(taskId))?.id;
