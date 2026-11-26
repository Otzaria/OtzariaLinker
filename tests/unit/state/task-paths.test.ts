import { describe, expect, it } from "vitest";
import { TASKS } from "../../../src/ui/screens/home";
import { DIRECT_TASKS, HOME_CARDS, isPathId, pathOfTask, TASK_PATHS, TASK_VARIANTS, variantGroup } from "../../../src/state/task-paths";

/*
 * Issue 20, V7 §3.1: the home screen had ten cards, then five paths. It is now one card per goal of the user — link books,
 * a repository, check and fix, continue a project — and no two choices do the same thing: a commentary and a notes book are
 * one choice (the sheet asks which), and so are several books and a folder against Otzaria (one guided flow). Nothing is
 * deleted: every task is still a route (#/start/<id>), reachable exactly once — chosen by a path, or a variant of a choice.
 */
const OLD_IDS = ["commentary", "notes", "several", "folder-otzaria", "db-db", "within-db", "edit-links", "db-links", "relink", "manual"];

describe("the home paths", () => {
  it("one card per goal: link books, a repository, check and fix, and an existing project", () => {
    expect(HOME_CARDS).toEqual(["auto", "repo", "fix", "project"]);
    expect(DIRECT_TASKS).toEqual([]);
  });

  it("every old task id is still a task (the old #/start/<id> routes stay as aliases), and none was lost", () => {
    const ids = TASKS.map((t) => t.id);
    for (const old of OLD_IDS) expect(ids, old).toContain(old);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every task is reachable exactly once: a path chooses it, it is a card of its own, or it is a variant of a choice", () => {
    const chosen: string[] = TASK_PATHS.flatMap((p) => [...p.choose]);
    expect(new Set(chosen).size).toBe(chosen.length);
    for (const t of TASKS) {
      const reach = (chosen.includes(t.id) ? 1 : 0) + (DIRECT_TASKS.includes(t.id) ? 1 : 0) + (t.id in TASK_VARIANTS ? 1 : 0);
      expect(reach, t.id).toBe(1);
    }
    for (const id of chosen) expect(TASKS.map((t) => t.id), id).toContain(id);
    // a variant belongs to a choice that a path offers
    for (const [variant, of] of Object.entries(TASK_VARIANTS)) expect(chosen, variant).toContain(of);
  });

  it("the choices: no two do the same thing (#20)", () => {
    expect(TASK_PATHS.find((p) => p.id === "auto")!.choose).toEqual(["commentary", "citations", "folder-otzaria", "manual"]);
    expect(TASK_PATHS.find((p) => p.id === "repo")!.choose).toEqual(["analyze", "db-db", "within-db", "db-links", "coverage"]);
    expect(TASK_PATHS.find((p) => p.id === "fix")!.choose).toEqual(["edit-links", "relink"]);
    // a notes book is the commentary choice's other answer; several books are the folder's guided flow
    expect(TASK_VARIANTS).toEqual({ notes: "commentary", several: "folder-otzaria" });
    expect(variantGroup("notes")).toBe("commentary");
    expect(variantGroup("commentary")).toBe("commentary");
    expect(variantGroup("db-db")).toBe("db-db");
    // the two answers of one choice are the same kind of start: both a sheet, or both the guided flow
    for (const [variant, of] of Object.entries(TASK_VARIANTS)) {
      const a = TASKS.find((t) => t.id === variant)!;
      const b = TASKS.find((t) => t.id === of)!;
      expect(!!a.guided, variant).toBe(!!b.guided);
    }
  });

  it("pathOfTask and isPathId", () => {
    expect(pathOfTask("notes")).toBe("auto");
    expect(pathOfTask("several")).toBe("auto");
    expect(pathOfTask("relink")).toBe("fix");
    expect(pathOfTask("manual")).toBe("auto");
    expect(isPathId("auto")).toBe(true);
    expect(isPathId("commentary")).toBe(false);
    expect(isPathId("manual")).toBe(false);
  });
});
