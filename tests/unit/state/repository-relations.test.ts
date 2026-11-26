import { describe, expect, it } from "vitest";
import { bookRelations } from "../../../src/state/repository";

/*
 * V7 §3.14: the relations of ONE book, for the small map of its details — its direct neighbours only, each with the database's
 * links both ways, the project's links (and how many of them the QA doubts), and a suggested pair; at most `max` of them.
 */
describe("the relations of one book", () => {
  const byBook = [
    { bookKey: "s1:2", title: "בסיס", out: 5, in: 0 },
    { bookKey: "s1:3", title: "מפרש", out: 0, in: 2 },
    { bookKey: "unresolved:x", title: "ספר סגור", out: 1, in: 0 },
    { bookKey: "s2:9", title: "מסד אחר", out: 0, in: 1 },
  ];
  const project = [
    { title: "בסיס", problem: false },
    { title: "בסיס", problem: true },
    { title: "חדש", problem: false },
  ];
  const proposals = [
    { dependant: { key: "s1:1", title: "הספר" }, base: { key: "s1:7", title: "בסיס מוצע" } },
    { dependant: { key: "s1:8", title: "הערות" }, base: { key: "s1:1", title: "הספר" } },
    { dependant: { key: "s1:5", title: "אחר" }, base: { key: "s1:6", title: "לא קשור" } },
  ];

  it("joins the database, the project and the suggestions by book, and says which end is outside this database", () => {
    const r = bookRelations("s1:1", "s1", byBook, project, proposals);
    const of = (t: string) => r.find((x) => x.title === t);
    expect(of("בסיס")).toEqual({ title: "בסיס", key: "s1:2", out: 5, in: 0, project: 2, problems: 1, external: false });
    expect(of("מפרש")).toMatchObject({ out: 0, in: 2, external: false });
    expect(of("ספר סגור")).toMatchObject({ external: true });
    expect(of("מסד אחר")).toMatchObject({ external: true });
    expect(of("חדש")).toMatchObject({ out: 0, in: 0, project: 1 });
    expect(of("בסיס מוצע")).toMatchObject({ suggested: "base", out: 0, project: 0 });
    expect(of("הערות")).toMatchObject({ suggested: "dependant" });
    expect(of("לא קשור")).toBeUndefined();
    // the heaviest first, and a suggestion is kept even when it has no links
    expect(r[0]!.title).toBe("בסיס");
  });

  it("keeps at most `max`, the suggested and the doubted ones among them", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ bookKey: `s1:${100 + i}`, title: `ספר ${i}`, out: 100 - i, in: 0 }));
    const r = bookRelations("s1:1", "s1", many, [{ title: "ספר 29", problem: true }], proposals, 8);
    expect(r).toHaveLength(8);
    expect(r.map((x) => x.title)).toEqual(expect.arrayContaining(["בסיס מוצע", "הערות", "ספר 29", "ספר 0"]));
  });
});
