import { describe, expect, it } from "vitest";
import type { BookRef, Link } from "../../../src/core/links/model";
import { applyRangeEdit, trimBefore, type RangeBook } from "../../../src/linking/ranges";
import { confidenceOf, DEFAULT_THRESHOLDS } from "../../../src/linking/automatic/types";
import { commit, emptyLinkState, undo } from "../../../src/state/history";

/*
 * Two version-3 behaviours the engine map (docs/validation/V7_ENGINE_MAP.md §18, gaps 14 and 15) found kept but
 * unproven, proven here: the confidence ladder of F-103, and an undone range cut giving back an untouched library
 * record (TD-H8: version 3 left it "edited").
 */
describe("kept from version 3", () => {
  it("F-103: ≥0.95 certain, ≥0.85 high (version 3's two levels), then possible from 0.6, and a close runner-up makes it ambiguous", () => {
    expect(DEFAULT_THRESHOLDS).toMatchObject({ certain: 0.95, high: 0.85, possible: 0.6, ambiguityMargin: 0.05 });
    expect(confidenceOf(0.95, null)).toBe("certain");
    expect(confidenceOf(0.9499, null)).toBe("high");
    expect(confidenceOf(0.85, null)).toBe("high");
    expect(confidenceOf(0.8499, null)).toBe("possible");
    expect(confidenceOf(0.6, null)).toBe("possible");
    expect(confidenceOf(0.59, null)).toBe("none");
    expect(confidenceOf(0.99, 0.95)).toBe("ambiguous");
    expect(confidenceOf(0.99, 0.94)).toBe("certain");
  });

  it("TD-H8 (F-083): undoing a range cut gives back the record exactly as it was, 'existing' again", () => {
    const A: BookRef = { key: "a", title: "ספר", origin: "otzaria" };
    const B: BookRef = { key: "b", title: "הערות", origin: "otzaria" };
    const record: Link = { id: "f1", status: "existing", provenance: "file", source: { book: A, line: 1, end: 6 }, target: { book: B, line: 0 }, declaredType: "commentary", heRef2: "הערות 1", fileIndex: 0 };
    const book: RangeBook = { owns: (r) => r.key === "a", lineCount: 10, headings: new Set() };
    const [cut] = trimBefore([record], book, "source", 4);
    const after = applyRangeEdit(cut!.link, "source", cut!.after);
    expect(after).toMatchObject({ status: "edited", source: { line: 1, end: 3 } });
    const s0 = commit(emptyLinkState(), "ייבוא", [{ id: record.id, after: record }]);
    const s1 = commit(s0, "קיצור", [{ id: record.id, before: record, after }]);
    expect(undo(s1).links.get(record.id)).toBe(record);
  });
});
