import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The built HTML carries the licence notice of every bundled package (build/plugins/license-notice.ts; MIT and BSD
 * require the notice to travel with copies; AGENTS.md §2.7). The list in vite.config.ts is written by hand, so a
 * package that comes in TRANSITIVELY was missed: @preact/signals imports @preact/signals-core, which is bundled, and
 * its notice was not in the file (V7 spec §4.18/§4.20 licence check). The runtime packages are the non-dev entries
 * of package-lock.json: every one of them must be in the list.
 */
const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { dev?: boolean; devOptional?: boolean }> };
const runtime = Object.entries(lock.packages)
  .filter(([path, p]) => path.startsWith("node_modules/") && !p.dev && !p.devOptional)
  .map(([path]) => path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length))
  .sort();

const config = readFileSync("vite.config.ts", "utf8");
const listed = [...(config.match(/licenseNotice\(\{[^)]*packages:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();

describe("the licence notices in the built file", () => {
  it("name every runtime package of the lock file, transitive ones included", () => {
    expect(runtime.length).toBeGreaterThanOrEqual(4);
    expect(listed).toEqual(runtime);
  });
});
