import { describe, expect, it } from "vitest";
import { coverageSummary } from "../../../src/ui/workspace/coverage-summary";

/*
 * #41 B14 (#17, V7 §3.12): after "approve all certain" two suggestions stayed pending, and the screen said "all 8
 * content lines are linked or covered by a range" though 2 lines had no link at all. A pending suggestion is not a link.
 */
const counts = (o: Partial<Record<"linked" | "unlinked" | "partial" | "multiple" | "not-suitable" | "candidate" | "doubtful", number>>) => {
  const byBucket = { linked: 0, unlinked: 0, partial: 0, multiple: 0, "not-suitable": 0, candidate: 0, doubtful: 0, ...o };
  const suitable = byBucket.linked + byBucket.unlinked + byBucket.partial + byBucket.multiple + byBucket.candidate + byBucket.doubtful;
  return { byBucket, suitable, unlinked: byBucket.unlinked, unlinkedShare: suitable ? byBucket.unlinked / suitable : 0, ranges: [] as unknown[] };
};

describe("coverage summary (B14)", () => {
  it("lines with only a pending suggestion are not 'linked'", () => {
    const s = coverageSummary(counts({ linked: 6, candidate: 2 }));
    expect(s).not.toContain("כל 8 שורות התוכן של הספר מקושרות");
    expect(s).toContain("2");
    expect(s).toContain("הצעה ממתינה");
  });
  it("all linked: as before", () => expect(coverageSummary(counts({ linked: 8 }))).toBe("כל 8 שורות התוכן של הספר מקושרות או מכוסות בטווח."));
  it("no content lines", () => expect(coverageSummary(counts({ "not-suitable": 3 }))).toBe("אין בספר שורות תוכן."));
  it("unlinked and pending together are both named", () => {
    const s = coverageSummary({ ...counts({ linked: 5, unlinked: 3, candidate: 2 }), ranges: [1, 2] });
    expect(s).toContain("3 מתוך 10");
    expect(s).toContain("2 שורות נוספות רק עם הצעה ממתינה");
  });
});
