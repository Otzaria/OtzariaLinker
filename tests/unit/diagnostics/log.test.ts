import { describe, expect, it } from "vitest";
import { Log } from "../../../src/diagnostics/log";

describe("Log", () => {
  it("is bounded and keeps the newest entries", () => {
    const log = new Log(3, () => 0);
    for (let i = 0; i < 5; i++) log.info("t", `m${i}`);
    expect(log.entries().map((e) => e.msg)).toEqual(["m2", "m3", "m4"]);
  });
  it("exports JSONL with code and data only when present", () => {
    const log = new Log(10, () => 7);
    log.info("db.open", "opened", { tables: 3 });
    log.error("export", "failed", undefined, "export/io");
    expect(log.toJsonl()).toBe(
      '{"t":7,"level":"info","area":"db.open","msg":"opened","data":{"tables":3}}\n' +
        '{"t":7,"level":"error","area":"export","msg":"failed","code":"export/io"}\n',
    );
  });
  it("notifies subscribers until they unsubscribe", () => {
    const log = new Log();
    const seen: string[] = [];
    const off = log.subscribe((e) => seen.push(e.msg));
    log.warn("a", "one");
    off();
    log.warn("a", "two");
    expect(seen).toEqual(["one"]);
  });
});
