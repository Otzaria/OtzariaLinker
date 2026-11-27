import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Every test starts sql.js through tests/support/sql-js.ts (loadSqlJs): its config type changed between @types/sql.js 1.4 and
 * 1.16 (a required `useOldExtensionFunctions`, Dependabot #35), and only the helper satisfies both. A test that called initSqlJs
 * itself (edition-identity, V7 round 2) broke the typecheck of the version bump.
 */
describe("sql.js in tests", () => {
  it("is started only through tests/support/sql-js.ts", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mts)$/.test(n)) files.push(p.split("\\").join("/"));
      }
    };
    walk("tests");
    const direct = files.filter((f) => f !== "tests/support/sql-js.ts" && /\binitSqlJs\s*\(/.test(readFileSync(f, "utf8")));
    expect(direct).toEqual([]);
  });
});
