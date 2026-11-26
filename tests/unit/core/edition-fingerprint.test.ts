import { describe, expect, it } from "vitest";
import { bytesFingerprint, EDITION_SAMPLES, editionFingerprint, editionSampleLines } from "../../../src/core/text/fingerprint";

/* V7 §1.1: a book's edition (state/edition.ts) — which lines it reads, and what changes it. */
describe("edition fingerprint", () => {
  it("reads every line of a short book, and EDITION_SAMPLES evenly spread lines of a long one, first and last included", () => {
    expect(editionSampleLines(0)).toEqual([]);
    expect(editionSampleLines(5)).toEqual([0, 1, 2, 3, 4]);
    const long = editionSampleLines(190_453);
    expect(long).toHaveLength(EDITION_SAMPLES);
    expect(long[0]).toBe(0);
    expect(long.at(-1)).toBe(190_452);
    expect([...long].sort((a, b) => a - b)).toEqual(long);
  });

  it("is the line count and a hash of the sampled lines: equal text equal edition; another count or a sampled line, another", () => {
    const at = [0, 1, 2];
    const e = editionFingerprint(3, at, ["א", "ב", "ג"]);
    expect(e).toMatch(/^3:[0-9a-f]{16}$/);
    expect(editionFingerprint(3, at, ["א", "ב", "ג"])).toBe(e);
    expect(editionFingerprint(3, at, ["א", "ב", "ד"])).not.toBe(e);
    expect(editionFingerprint(4, at, ["א", "ב", "ג"])).not.toBe(e);
    // the same texts at other line numbers are another edition; a missing line is not an empty one
    expect(editionFingerprint(3, [0, 2, 1], ["א", "ב", "ג"])).not.toBe(e);
    expect(editionFingerprint(3, at, ["א", undefined, "ג"])).not.toBe(editionFingerprint(3, at, ["א", "", "ג"]));
  });

  it("bytesFingerprint tells bytes apart, with their length", () => {
    expect(bytesFingerprint(new Uint8Array([1, 2, 3]))).toMatch(/^3:[0-9a-f]{16}$/);
    expect(bytesFingerprint(new Uint8Array([1, 2, 3]))).not.toBe(bytesFingerprint(new Uint8Array([1, 2, 4])));
  });
});
