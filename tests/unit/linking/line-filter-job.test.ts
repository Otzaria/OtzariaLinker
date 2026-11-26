import { describe, expect, it } from "vitest";
import type { BookRef } from "../../../src/core/links/model";
import { bookFingerprint, parseJobRecord, stepsSignature } from "../../../src/linking/batch-job";
import type { PlanStep } from "../../../src/linking/plan";
import { parseGuidedRecord } from "../../../src/state/guided-flow";

/*
 * Findings #40 A1: the line filter is the run's, and a max-link job and a guided flow keep it. A book's result depends on it like on any engine
 * setting: a changed filter changes the book's fingerprint, so a result found under another filter is never reused as "unchanged".
 */
const ref = (key: string, title: string): BookRef => ({ key, title, origin: "otzaria" });
const C = ref("s1:ביאור על בראשית.txt", "ביאור על בראשית");
const B = ref("s1:בראשית.txt", "בראשית");
const pair = (engine: "headings" | "dibur-hamatchil"): PlanStep => ({ id: `${engine}:${C.key}>${B.key}`, kind: "pair", engine, source: C, target: B, relation: {} as never, why: "" }) as PlanStep;
const fps = { [C.key]: "c1", [B.key]: "b1" };
const steps = [pair("headings"), pair("dibur-hamatchil")];

describe("the job's fingerprint follows the run's line filter", () => {
  it("no filter: the same signature as before the filter was the run's (an older job's books stay unchanged)", () => {
    expect(stepsSignature(steps, undefined, null)).toBe(stepsSignature(steps));
    expect(bookFingerprint(steps, fps, undefined, null)).toBe(bookFingerprint(steps, fps));
  });

  it("a filter, another prefix, another mode or another strip: another fingerprint; the same filter: the same", () => {
    const none = bookFingerprint(steps, fps);
    const sq = bookFingerprint(steps, fps, undefined, { prefix: { preset: "square" } });
    expect(sq).not.toBe(none);
    expect(bookFingerprint(steps, fps, undefined, { prefix: { preset: "square" } })).toBe(sq);
    expect(bookFingerprint(steps, fps, undefined, { prefix: { preset: "round" } })).not.toBe(sq);
    expect(bookFingerprint(steps, fps, undefined, { prefix: { preset: "square" }, mode: "exclude" })).not.toBe(sq);
    expect(bookFingerprint(steps, fps, undefined, { prefix: { preset: "square" }, strip: false })).not.toBe(sq);
    expect(bookFingerprint(steps, fps, undefined, { prefix: { regex: String.raw`\{\d+\}` } })).not.toBe(sq);
    // "include" is the default: written or not, the same filter
    expect(bookFingerprint(steps, fps, undefined, { prefix: { preset: "square" }, mode: "include" })).toBe(sq);
  });
});

describe("the filter read back from the browser", () => {
  const job = (lineFilter: unknown) => JSON.stringify({ v: 1, id: "x", scope: "s", sources: ["a"], state: "paused", books: [], startedAt: 1, ms: 1, ...(lineFilter !== undefined && { lineFilter }) });
  it("a job keeps a valid filter; a damaged one drops the whole record (the job must not go on without it)", () => {
    expect(parseJobRecord(job({ prefix: { preset: "square" }, mode: "exclude" }))!.lineFilter).toEqual({ prefix: { preset: "square" }, mode: "exclude" });
    expect(parseJobRecord(job(undefined))!.lineFilter).toBeUndefined();
    expect(parseJobRecord(job({ prefix: { regex: "(a+)+$" } }))).toBeNull();
    expect(parseJobRecord(job({ prefix: { preset: "nope" } }))).toBeNull();
    expect(parseJobRecord(job("square"))).toBeNull();
  });

  // V7 PR2 review, finding 5: a job saved before the filter was the run's kept it under the dibur-hamatchil options only
  it("a job saved before the filter was the run's: the filter under an engine becomes the run's, and its books run again", () => {
    const old = JSON.stringify({ v: 1, id: "x", scope: "s", sources: ["a"], state: "paused", books: [], startedAt: 1, ms: 1, engineOptions: { "dibur-hamatchil": { sourceFilter: { prefix: { preset: "square" } }, maxDhWords: 8 } } });
    const job = parseJobRecord(old)!;
    expect(job.lineFilter).toEqual({ prefix: { preset: "square" } });
    expect(job.engineOptions).toEqual({ "dibur-hamatchil": { maxDhWords: 8 } });
    // the fingerprint the old job stored (computed with the filter under dibur-hamatchil, none for the run) no longer matches
    const stored = bookFingerprint(steps, fps, { "dibur-hamatchil": { sourceFilter: { prefix: { preset: "square" } }, maxDhWords: 8 } }, undefined);
    expect(bookFingerprint(steps, fps, job.engineOptions, job.lineFilter)).not.toBe(stored);
    // two different filters under two engines: not one run's statement — the record is dropped, never resumed with one of them
    const conflict = JSON.stringify({ ...JSON.parse(old), engineOptions: { "dibur-hamatchil": { sourceFilter: { prefix: { preset: "square" } } }, headings: { sourceFilter: { prefix: { preset: "round" } } } } });
    expect(parseJobRecord(conflict)).toBeNull();
  });

  it("a guided flow likewise", () => {
    const flow = (lineFilter: unknown) => JSON.stringify({ v: 1, step: "plan", sources: [], purpose: "submission", links: 0, done: false, savedAt: 1, ...(lineFilter !== undefined && { lineFilter }) });
    expect(parseGuidedRecord(flow({ prefix: { preset: "round" } }))!.lineFilter).toEqual({ prefix: { preset: "round" } });
    expect(parseGuidedRecord(flow(undefined))!.lineFilter).toBeUndefined();
    expect(parseGuidedRecord(flow({ prefix: { regex: "(a+)+$" } }))).toBeNull();
    expect(parseGuidedRecord(flow(7))).toBeNull();
  });
});
