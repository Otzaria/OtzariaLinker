import { describe, expect, it } from "vitest";
import type { CoverageSummary } from "../../../src/linking/coverage";
import { countCoverage, coverageTrust, needsRecount, type FailedCount, type PanelSummary } from "../../../src/ui/workspace/coverage-compute";

const SUMMARY: CoverageSummary = {
  total: 10,
  byBucket: { linked: 4, unlinked: 5, partial: 0, multiple: 0, "not-suitable": 1, candidate: 0, doubtful: 0 },
  suitable: 9,
  unlinked: 5,
  unlinkedShare: 5 / 9,
  ranges: [{ start: 1, end: 5 }],
};

/**
 * The panel's effect, as the page runs it: after every render in which nothing is busy, the rule asks whether to count again; a
 * count sets `busy` (a render), and its end sets the summary or the failure (another render, which asks again). `maxRenders` stops
 * a loop that would never end, which is what the test measures.
 */
async function runPanel(count: (k: string) => Promise<CoverageSummary | null>, start: PanelSummary | null, bookKey: string, revision: number, maxRenders = 50) {
  let summary = start;
  let failed: FailedCount | null = null;
  let calls = 0;
  for (let renders = 0; renders < maxRenders; renders++) {
    if (!needsRecount({ summary, bookKey, revision, busy: false, failed })) return { calls, summary, failed, looped: false };
    calls++;
    failed = null;
    const out = await countCoverage(async (k) => count(k), bookKey, revision);
    if (out.ok) summary = out.summary;
    else failed = out.failed;
  }
  return { calls, summary, failed, looped: true };
}

describe("coverage panel count: stopped, and what the read of the links says", () => {
  it("a count the user stopped (null, the book is open) is not a failure: it is remembered by revision, with no message", async () => {
    const out = await countCoverage(async () => null, "b", 3, () => true);
    expect(out).toMatchObject({ ok: false, failed: { bookKey: "b", revision: 3, cancelled: true, message: "" } });
  });

  it("null for a book that is not open is still the 'not open' failure", async () => {
    const out = await countCoverage(async () => null, "b", 3, () => false);
    expect(out.ok === false && out.failed.message).toContain("הספר לא פתוח");
    expect(out.ok === false && out.failed.cancelled).toBeUndefined();
  });

  it("a stopped count does not make the panel ask again by itself", () => {
    const stale: PanelSummary = { ...SUMMARY, bookKey: "b", revision: 1 };
    expect(needsRecount({ summary: stale, bookKey: "b", revision: 2, busy: false, failed: { bookKey: "b", revision: 2, message: "", cancelled: true } })).toBe(false);
  });

  it("coverageTrust: counted and none are reliable (a book with no links IS all unlinked); failed and unknown are not, and say why", () => {
    expect(coverageTrust({ state: "counted", count: 3 })).toEqual({ reliable: true });
    expect(coverageTrust({ state: "none" })).toEqual({ reliable: true });
    expect(coverageTrust(undefined)).toEqual({ reliable: true }); // a saved coverage: only a reliable one is ever saved
    const failed = coverageTrust({ state: "failed", message: "disk" });
    expect(failed.reliable).toBe(false);
    expect(failed.reliable === false && failed.text).toContain("נכשלה");
    expect(failed.reliable === false && failed.kind).toBe("failed");
    const unknown = coverageTrust({ state: "unknown", why: "not-read" });
    expect(unknown.reliable === false && unknown.kind).toBe("unknown");
    expect(unknown.reliable === false && unknown.text).not.toContain("נכשלה");
  });
});

describe("coverage panel count", () => {
  it("a count that gives nothing is a failure with a message, not an exception", async () => {
    const out = await countCoverage(async () => null, "b", 3);
    expect(out).toMatchObject({ ok: false, failed: { bookKey: "b", revision: 3 } });
    expect(out.ok === false && out.failed.message).toContain("הספר לא פתוח");
  });

  it("a count that throws is a failure with the error's message", async () => {
    const out = await countCoverage(async () => Promise.reject(new Error("boom")), "b", 3);
    expect(out.ok === false && out.failed.message).toBe("חישוב הכיסוי נכשל: boom");
  });

  it("a count that succeeds carries the book and the revision it was made for", async () => {
    const out = await countCoverage(async () => SUMMARY, "b", 7);
    expect(out.ok && out.summary).toMatchObject({ bookKey: "b", revision: 7, unlinked: 5 });
  });

  it("the links changed and the new count gives nothing: it is asked once, not forever", async () => {
    const stale: PanelSummary = { ...SUMMARY, bookKey: "b", revision: 1 };
    let calls = 0;
    const r = await runPanel(async () => (calls++, null), stale, "b", 2);
    expect(r.looped).toBe(false);
    expect(calls).toBe(1);
    expect(r.failed).toMatchObject({ bookKey: "b", revision: 2 });
  });

  it("the links changed and the new count throws: asked once, and the failure is there to show", async () => {
    const stale: PanelSummary = { ...SUMMARY, bookKey: "b", revision: 1 };
    let calls = 0;
    const r = await runPanel(async () => (calls++, Promise.reject(new Error("x"))), stale, "b", 2);
    expect(r.looped).toBe(false);
    expect(calls).toBe(1);
    expect(r.failed?.message).toContain("x");
  });

  it("a later change of the links is counted again after a failure, and a success settles it", async () => {
    const stale: PanelSummary = { ...SUMMARY, bookKey: "b", revision: 1 };
    const failedAtTwo: FailedCount = { bookKey: "b", revision: 2, message: "m" };
    expect(needsRecount({ summary: stale, bookKey: "b", revision: 2, busy: false, failed: failedAtTwo })).toBe(false);
    expect(needsRecount({ summary: stale, bookKey: "b", revision: 3, busy: false, failed: failedAtTwo })).toBe(true);
    const r = await runPanel(async () => SUMMARY, stale, "b", 3);
    expect(r).toMatchObject({ calls: 1, looped: false });
    expect(r.summary?.revision).toBe(3);
  });

  it("nothing is counted by itself before the first count, while busy, or for another book", () => {
    const s: PanelSummary = { ...SUMMARY, bookKey: "b", revision: 1 };
    expect(needsRecount({ summary: null, bookKey: "b", revision: 2, busy: false, failed: null })).toBe(false);
    expect(needsRecount({ summary: s, bookKey: "b", revision: 2, busy: true, failed: null })).toBe(false);
    expect(needsRecount({ summary: s, bookKey: "c", revision: 2, busy: false, failed: null })).toBe(false);
    expect(needsRecount({ summary: s, bookKey: "b", revision: 1, busy: false, failed: null })).toBe(false);
  });
});
