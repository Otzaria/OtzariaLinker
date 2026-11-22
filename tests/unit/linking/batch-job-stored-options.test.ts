import { describe, expect, it } from "vitest";
import { parseJobRecord, type JobRecord } from "../../../src/linking/batch-job";

const base = (engineOptions: unknown): string =>
  JSON.stringify({ v: 1, id: "x", scope: "s", sources: ["a"], state: "paused", books: [], startedAt: 1, ms: 1, engineOptions });

describe("engineOptions read back from the browser are validated like the form's (QA round 2, A)", () => {
  it("a hostile pattern, marker regex or out-of-range value is dropped, a valid one is kept", () => {
    const r = parseJobRecord(
      base({
        pattern: { regex: "(a+)+$", position: "start", carry: true, bogus: 1 },
        footnotes: { mainMarkers: { regex: "a{1,500}a{1,500}a{1,500}b" }, notesMarkers: { tag: "small" }, numbering: "digits" },
        headings: { maxAlternatives: 9999, thresholds: { certain: 0.9, high: 0.8, possible: 0.5, ambiguityMargin: 0.1 } },
        citations: { minConfidence: "nonsense", ibid: "yes", ranges: false },
      }),
    ) as JobRecord;
    expect(r.engineOptions).toEqual({
      pattern: { position: "start", carry: true },
      footnotes: { notesMarkers: { tag: "small" }, numbering: "digits" },
      headings: { maxAlternatives: 10, thresholds: { certain: 0.9, high: 0.8, possible: 0.5, ambiguityMargin: 0.1 } },
      citations: { ranges: false },
    });
  });
  it("a record whose engineOptions is not an object per engine keeps no options", () => {
    expect(parseJobRecord(base({ pattern: "x", nope: { a: 1 } }))!.engineOptions).toEqual({});
    expect(parseJobRecord(base([1, 2]))!.engineOptions).toBeUndefined();
  });
});
