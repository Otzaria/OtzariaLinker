import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localDateStamp } from "../../../src/core/file-date";

/*
 * A downloaded file is named by the user's own date (V7 live run 3, §9.8): `toISOString()` is UTC, so in Israel from 22:00 (21:00
 * in winter) until midnight a file saved on the 27th was named the 26th. The project file had it right already (#42 C28).
 */
describe("the date in a downloaded file's name", () => {
  it("is the local date: half an hour after local midnight is already the new day", () => {
    expect(localDateStamp(new Date(2026, 10, 27, 0, 30))).toBe("2026-11-27");
    expect(localDateStamp(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("no file name in the code takes its date from toISOString (UTC)", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(n)) files.push(p);
      }
    };
    walk("src");
    const utc = files.filter((f) => /toISOString\(\)\.slice\(0, ?10\)/.test(readFileSync(f, "utf8")));
    expect(utc).toEqual([]);
  });
});
