import { describe, expect, it } from "vitest";
import { TASKS } from "../../../src/ui/screens/home";
import { DIRECT_TASKS, HOME_CARDS, isPathId, pathOfTask, TASK_PATHS } from "../../../src/state/task-paths";

/*
 * Issue 20: the home screen had ten cards. It has five paths; the choice between a commentary, footnotes, citations,
 * several books or a folder against Otzaria moves into the wizard. Nothing is deleted: every task is still a route
 * (#/start/<id>), and every task is reachable from exactly one path.
 */
const OLD_IDS = ["commentary", "notes", "several", "folder-otzaria", "db-db", "within-db", "edit-links", "db-links", "relink", "manual"];

describe("the home paths", () => {
  it("five main paths: automatic, manual, a repository, check and fix, and an existing project", () => {
    expect(HOME_CARDS).toEqual(["auto", "manual", "repo", "fix", "project"]);
  });

  it("every old task id is still a task (the old #/start/<id> routes stay as aliases), and none was lost", () => {
    const ids = TASKS.map((t) => t.id);
    for (const old of OLD_IDS) expect(ids, old).toContain(old);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every task is reachable: either a path chooses it, or it is a path of its own — exactly once", () => {
    const chosen: string[] = TASK_PATHS.flatMap((p) => [...p.choose]);
    expect(new Set(chosen).size).toBe(chosen.length);
    for (const t of TASKS) {
      const reach = (chosen.includes(t.id) ? 1 : 0) + (DIRECT_TASKS.includes(t.id) ? 1 : 0);
      expect(reach, t.id).toBe(1);
    }
    for (const id of chosen) expect(TASKS.map((t) => t.id), id).toContain(id);
  });

  it("the choices: commentary, notes, citations, several and a folder against Otzaria are one path", () => {
    expect(TASK_PATHS.find((p) => p.id === "auto")!.choose).toEqual(["commentary", "notes", "citations", "several", "folder-otzaria"]);
    expect(TASK_PATHS.find((p) => p.id === "repo")!.choose).toEqual(["analyze", "db-db", "within-db", "db-links", "coverage"]);
    expect(TASK_PATHS.find((p) => p.id === "fix")!.choose).toEqual(["edit-links", "relink"]);
  });

  it("pathOfTask and isPathId", () => {
    expect(pathOfTask("notes")).toBe("auto");
    expect(pathOfTask("relink")).toBe("fix");
    expect(pathOfTask("manual")).toBeUndefined();
    expect(isPathId("auto")).toBe(true);
    expect(isPathId("commentary")).toBe(false);
    expect(isPathId("manual")).toBe(false);
  });
});
