import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { problemText, type ValidationContext } from "../../../src/core/links/validate";
import { qaCsv, redundantDuplicates, runQa } from "../../../src/linking/qa";
import { planExport } from "../../../src/formats/links-json/export";

const A: BookRef = { key: "a", title: "פירוש", origin: "otzaria", isBaseBook: false };
const B: BookRef = { key: "b", title: "בסיס", origin: "otzaria", isBaseBook: false };
const ctx: ValidationContext = { lineCount: () => 10, line: (_b, i) => ({ exists: true, heading: i === 0 ? 1 : null, anchorLength: 20 }) };
const mk = (id: string, over: Partial<Link> = {}): Link => ({ id, status: "new", provenance: "user", source: { book: A, line: 2 }, target: { book: B, line: 3 }, declaredType: "commentary", heRef2: "בסיס ד", ...over });

describe("QA report", () => {
  const report = runQa(
    [
      mk("ok"),
      mk("dup"), // same stored link as "ok"
      mk("head", { target: { book: B, line: 0 } }),
      mk("far", { target: { book: B, line: 40 } }),
      mk("type", { declaredType: "commantary" }),
      mk("gone", { status: "deleted", target: { book: B, line: 0 } }),
      mk("db", { provenance: "db", status: "existing", target: { book: B, line: 0 } }),
    ],
    ctx,
  );

  it("checks only live project links and groups problems into categories", () => {
    expect(report.checked).toBe(5);
    expect(report.byCategory).toMatchObject({ duplicate: 1, heading: 1, "out-of-range": 1, type: 1 });
    expect(report.clean).toBe(1);
  });

  it("orders errors first", () => {
    expect(report.issues[0]!.problem.severity).toBe("error");
  });

  it("offers only the later copy of a duplicate for deletion", () => {
    expect(redundantDuplicates(report)).toEqual(["dup"]);
  });

  it("exports a CSV Excel can read in Hebrew", () => {
    const csv = qaCsv(report);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.split("\r\n").length).toBe(report.issues.length + 2);
  });

  it("keeps the plain words in the text and the field names apart, for advanced mode and the saved reports (audit F14)", () => {
    const r = runQa([mk("noref", { heRef2: " " })], ctx);
    const missing = r.issues.find((i) => i.problem.code === "export/heref-missing")!.problem;
    expect(missing.message).not.toContain("heRef_2");
    expect(missing.detail).toBe("heRef_2");
    expect(problemText(missing)).toBe(missing.message);
    expect(problemText(missing, true)).toBe(`${missing.message} (heRef_2)`);
    expect(qaCsv(r)).toContain('"export/heref-missing","heRef_2"');
  });
});

describe("the check and the export agree (product audit F7)", () => {
  // scenario 11: a library file's record points past the end of its target, and one the user made does too
  const untouched = mk("lib", { provenance: "file", status: "existing", fileIndex: 0, target: { book: B, line: 40 } });
  const made = mk("new", { target: { book: B, line: 40 } });
  const report = runQa([untouched, made], ctx);
  const plan = planExport([untouched, made], ctx);
  const sev = (id: string) => report.issues.filter((i) => i.link.id === id && i.problem.code === "export/line-out-of-range").map((i) => i.problem.severity);

  it("an untouched library record the export keeps is a warning in the check too, and says it is kept as is", () => {
    expect(plan.warned.map((w) => w.link.id)).toEqual(["lib"]);
    expect(sev("lib")).toEqual(["warning"]);
    expect(report.issues.find((i) => i.link.id === "lib")!.problem.message).toContain("כמו שהיא");
  });

  it("a record the export holds back is an error in the check", () => {
    expect(plan.heldBack.map((h) => h.link.id)).toEqual(["new"]);
    expect(sev("new")).toEqual(["error"]);
  });

  it("every link the check calls an error is held back by the export, and only those", () => {
    const errors = new Set(report.issues.filter((i) => i.problem.severity === "error").map((i) => i.link.id));
    expect(new Set(plan.heldBack.map((h) => h.link.id))).toEqual(errors);
  });
});
