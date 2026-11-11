import { describe, expect, it } from "vitest";
import { Log } from "../../../src/diagnostics/log";
import { diagnosticsFile, diagnosticsFileName, logNotice, logTask } from "../../../src/state/diagnostics";

describe("diagnostics", () => {
  it("notices are logged by severity, with their details capped", () => {
    const log = new Log(100, () => 1);
    logNotice(log, "error", "נכשל", ["a"]);
    logNotice(log, "warning", "אזהרה", Array.from({ length: 80 }, (_, i) => `d${i}`));
    logNotice(log, "success", "נפתחו");
    expect(log.entries().map((e) => [e.level, e.area, e.msg])).toEqual([["error", "notice", "נכשל"], ["warn", "notice", "אזהרה"], ["info", "notice", "נפתחו"]]);
    expect((log.entries()[1]!.data!.details as string[]).length).toBe(50);
  });

  it("a task logs its duration and outcome; a failure keeps the error code", () => {
    let t = 1000;
    const log = new Log(100, () => t);
    const now = () => t;
    const a = logTask(log, "פותח", now);
    t = 1250;
    a.ok();
    const b = logTask(log, "מחפש", now);
    b.cancelled();
    const c = logTask(log, "קורא", now);
    c.failed(Object.assign(new Error("פגום"), { code: "db/corrupt" }));
    const ends = log.entries().filter((e) => e.level !== "debug");
    expect(ends.map((e) => [e.msg, e.data?.outcome, e.data?.ms])).toEqual([["פותח", "ok", 250], ["מחפש", "cancelled", 0], ["קורא", "failed", 0]]);
    expect(ends[2]!.code).toBe("db/corrupt");
  });

  it("the file is a header line then one entry per line", () => {
    const log = new Log(10, () => 5);
    log.info("open", "2 files");
    const text = diagnosticsFile({ app: "2.0.0", commit: "abc", built: "x", savedAt: "y", userAgent: "z", sources: [], links: 0, prefs: {} }, log.entries());
    const lines = text.trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].header.app).toBe("2.0.0");
    expect(lines[1]).toEqual({ t: 5, level: "info", area: "open", msg: "2 files" });
    expect(diagnosticsFileName(new Date("2026-11-11T20:01:02Z"))).toBe("otzaria-linker-diagnostics-2026-11-11-20-01-02.jsonl");
  });
});
