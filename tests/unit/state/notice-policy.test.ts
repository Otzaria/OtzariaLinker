import { describe, expect, it } from "vitest";
import { NOTICE_LONG_MS, NOTICE_SHORT_MS, noticeLifetimeMs } from "../../../src/state/notice-policy";

describe("how long a notice stays (audit F16)", () => {
  it("errors and notices with an action stay until closed", () => {
    expect(noticeLifetimeMs({ kind: "error" })).toBeNull();
    expect(noticeLifetimeMs({ kind: "info", action: { label: "x", run: () => {} } })).toBeNull();
  });
  it("warnings and notices with details fade after a longer read; the rest after a short one", () => {
    expect(noticeLifetimeMs({ kind: "warning" })).toBe(NOTICE_LONG_MS);
    expect(noticeLifetimeMs({ kind: "info", details: ["a"] })).toBe(NOTICE_LONG_MS);
    expect(noticeLifetimeMs({ kind: "success" })).toBe(NOTICE_SHORT_MS);
    expect(NOTICE_LONG_MS).toBeGreaterThan(NOTICE_SHORT_MS);
  });
});

describe("files that did not open (#41 B24)", () => {
  it("a sticky notice stays until it is closed: the reason must not fade before it can be read", async () => {
    const { noticeLifetimeMs } = await import("../../../src/state/notice-policy");
    expect(noticeLifetimeMs({ kind: "warning", details: ["x: y"], sticky: true })).toBeNull();
  });
});
