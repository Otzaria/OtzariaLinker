import { describe, expect, it } from "vitest";
import { linkOrigins } from "../../../src/ui/workspace/coverage-summary";

/*
 * #17 / V7 §3.12: the coverage report counts a book's links by where they come from, apart — the database's, imported, made by hand,
 * approved suggestions, and the suggestions still pending or rejected. The database's count is unknown (null) when its read failed or
 * was not made, never 0; a text book has no database.
 */
describe("the links of a book by origin", () => {
  const links = [
    { provenance: "file", status: "unchanged" },
    { provenance: "import", status: "new" },
    { provenance: "user", status: "new" },
    { provenance: "db-copy", status: "new" },
    { provenance: "auto", status: "new" },
    { provenance: "auto", status: "new" },
    { provenance: "user", status: "deleted" },
  ] as const;
  const states = ["pending", "pending", "rejected", "approved", "exists"] as const;

  it("counts each origin apart, and the suggestions by their state", () => {
    expect(linkOrigins(links, { state: "counted", count: 12 }, states)).toEqual({ db: 12, imported: 2, manual: 2, approved: 2, pending: 2, rejected: 1 });
  });

  it("the database's count is unknown when its read failed or was not made, 0 when it has none, and absent for a text book", () => {
    expect(linkOrigins([], { state: "failed", message: "x" }, []).db).toBeNull();
    expect(linkOrigins([], { state: "unknown", why: "not-read" }, []).db).toBeNull();
    expect(linkOrigins([], { state: "none" }, []).db).toBe(0);
    expect(linkOrigins([], { state: "no-database" }, []).db).toBeUndefined();
  });
});
