import { describe, expect, it } from "vitest";
import { countOf, elapsedText, ETA_AFTER_MS, remainingText, stageText } from "../../../src/state/task-progress";

describe("what a running task says besides its name (V7 §3.16, #41 B11)", () => {
  const t0 = 1_000_000;
  it("before its first count, that it is preparing — never a bare 0/0", () => {
    expect(stageText({ done: 0, total: 0 })).toBe("מכין את העבודה…");
    expect(stageText({ done: 3, total: 10, count: "ספר 3 מתוך 10" })).toBe("ספר 3 מתוך 10");
    expect(stageText({ done: 3, total: 10 })).toBe("30%");
  });
  it("the time since it started, once it is long enough to matter", () => {
    expect(elapsedText(t0, t0 + 2_000)).toBeNull();
    expect(elapsedText(t0, t0 + 12_000)).toBe("0:12");
    expect(elapsedText(t0, t0 + 125_000)).toBe("2:05");
    expect(elapsedText(t0, t0 + 3_725_000)).toBe("1:02:05");
  });
});

describe("the time left of a long task (audit F21)", () => {
  const t0 = 1_000_000;
  it("says nothing while an estimate would be a guess", () => {
    expect(remainingText(t0, 0, 100, t0 + 60_000)).toBeNull(); // nothing done yet
    expect(remainingText(t0, 50, 100, t0 + ETA_AFTER_MS - 1)).toBeNull(); // too early
    expect(remainingText(t0, 1, 100, t0 + 60_000)).toBeNull(); // too little done
    expect(remainingText(t0, 100, 100, t0 + 60_000)).toBeNull(); // done
    expect(remainingText(t0, 5, 0, t0 + 60_000)).toBeNull(); // no total
  });
  it("extrapolates from the pace so far, in words", () => {
    // 6 minutes: 30% after 108 s → 252 s left ≈ 4 minutes
    expect(remainingText(t0, 30, 100, t0 + 108_000)).toBe("עוד כ־4 דקות");
    expect(remainingText(t0, 90, 100, t0 + 60_000)).toBe("עוד פחות מדקה");
    expect(remainingText(t0, 50, 100, t0 + 60_000)).toBe("עוד כדקה");
    expect(remainingText(t0, 10, 100, t0 + 20 * 60_000)).toBe("עוד כ־3 שעות");
  });
  it("counts in the task's own units, never past the end", () => {
    expect(countOf("ספר", 120, 300)).toBe("ספר 120 מתוך 300");
    expect(countOf("שלב", 1801, 1800)).toBe("שלב 1,800 מתוך 1,800");
  });
});
