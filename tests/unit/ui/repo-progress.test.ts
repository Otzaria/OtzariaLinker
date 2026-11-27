import { describe, expect, it } from "vitest";
import { repoProgressText } from "../../../src/ui/dialogs/repo-progress";

/*
 * #41 B25: the repository analysis showed "0 מתוך 3,372" for about 30 seconds on v52 with a cold cache — the first book waits
 * for one scan of the database's link tables, and nothing said so. Before the first book: what is happening and why it waits.
 */
describe("repository analysis progress (B25)", () => {
  it("before the first book is read, it says the database is being prepared, not '0 of N'", () => {
    const t = repoProgressText({ stage: "links", done: 0, total: 3372 });
    expect(t).not.toMatch(/^נקראו הקישורים של 0/);
    expect(t).toContain("מכין");
    expect(t).toContain("3,372");
  });
  it("then the count, as before", () => {
    expect(repoProgressText({ stage: "links", done: 61, total: 3372 })).toBe("נקראו הקישורים של 61 מתוך 3,372 ספרים. אפשר לעצור, והספרים שנקראו נשמרים.");
    expect(repoProgressText({ stage: "coverage", done: 0, total: 5 })).toBe("חושב כיסוי של 0 מתוך 5 ספרים. אפשר לעצור, והספרים שנקראו נשמרים.");
  });
});
