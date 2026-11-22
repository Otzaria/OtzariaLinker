import { describe, expect, it } from "vitest";
import { assignOpenSources, candidatesFor, type OpenSource } from "../../../src/ui/screens/task-sources";

/* #22: a task sheet offers the sources that are already open instead of asking for the same database again. */
const OFFICIAL: OpenSource = { id: "s1", kind: "otzaria-db", library: true };
const PERSONAL: OpenSource = { id: "s2", kind: "otzaria-db", library: false };
const FOLDER: OpenSource = { id: "s3", kind: "text-files", library: false };
const ALL = [OFFICIAL, PERSONAL, FOLDER];

describe("candidatesFor", () => {
  it("a database step takes databases, a folder step takes text sources", () => {
    expect(candidatesFor({ options: ["db"] }, ALL).map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    expect(candidatesFor({ options: ["folder", "files"] }, ALL).map((s) => s.id)).toEqual(["s3"]);
  });
  it("a step that asks for Otzaria's database lists the library first", () => {
    expect(candidatesFor({ options: ["db"], dbHint: true }, [PERSONAL, OFFICIAL]).map((s) => s.id)).toEqual(["s1", "s2"]);
  });
  it("a step without the hint prefers the user's own database", () => {
    expect(candidatesFor({ options: ["db"] }, [OFFICIAL, PERSONAL]).map((s) => s.id)).toEqual(["s2", "s1"]);
  });
  it("a source already taken is not offered again", () => {
    expect(candidatesFor({ options: ["db"] }, ALL, new Set(["s1"])).map((s) => s.id)).toEqual(["s2"]);
  });
});

describe("assignOpenSources", () => {
  const folderOtzaria = [{ options: ["folder", "zip", "files"] }, { options: ["db"], dbHint: true }];
  it("each step takes the open source it needs, once", () => {
    expect(assignOpenSources(folderOtzaria, ALL, {})).toEqual({ 0: ["s3"], 1: ["s1"] });
  });
  it("db-to-db takes two different databases, not the same one twice", () => {
    const dbDb = [{ options: ["db"] }, { options: ["db"], dbHint: true }];
    expect(assignOpenSources(dbDb, ALL, {})).toEqual({ 0: ["s2"], 1: ["s1"] });
    expect(assignOpenSources(dbDb, [OFFICIAL], {})).toEqual({ 0: ["s1"] }); // one database: the second step stays open
  });
  it("steps that are done keep their source, and an optional step does not starve a required one", () => {
    const steps = [{ options: ["db"], optional: true }, { options: ["db"] }];
    expect(assignOpenSources(steps, [OFFICIAL], {})).toEqual({ 1: ["s1"] });
    expect(assignOpenSources(folderOtzaria, ALL, { 1: ["s2"] })).toEqual({ 0: ["s3"] });
  });
});
