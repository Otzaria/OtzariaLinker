import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import type { ValidationContext } from "../../../src/core/links/validate";
import { qaCsv, redundantDuplicates, runQa } from "../../../src/linking/qa";

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
});
