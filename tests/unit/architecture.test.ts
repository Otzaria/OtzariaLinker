import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Module boundaries (docs/ARCHITECTURE.md). A layer may import only from itself and the layers
 * listed for it. `core` is pure: no DOM framework, no database, no UI.
 */
const ALLOWED: Record<string, readonly string[]> = {
  core: [],
  matching: ["core"],
  linking: ["core", "matching"],
  formats: ["core"],
  database: ["core"],
  sources: ["core", "database", "formats"],
  projects: ["core", "formats"],
  diagnostics: ["core"],
  workers: ["core", "database", "matching", "linking", "formats", "sources", "diagnostics"],
  state: ["core", "linking", "matching", "formats", "projects", "diagnostics"],
  ui: ["core", "state", "linking", "matching", "formats", "diagnostics"],
  app: ["core", "state", "ui", "workers", "linking", "matching", "formats", "database", "sources", "projects", "diagnostics"],
};
const PURE = new Set(["core", "matching", "linking", "formats"]);
const FRAMEWORK = /^(preact|@preact\/)/;

const SRC = resolve("src");
function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.tsx?$/.test(name)) yield p;
  }
}
const layerOf = (absPath: string) => relative(SRC, absPath).split(sep)[0]!;

describe("architecture boundaries", () => {
  const violations: string[] = [];
  for (const file of files(SRC)) {
    const from = layerOf(file);
    if (!(from in ALLOWED)) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+["']([^"']+)["']/gm)) {
      const spec = m[1]!;
      const rel = relative(SRC, file);
      if (spec.startsWith(".")) {
        const to = layerOf(resolve(file, "..", spec));
        if (to !== from && !ALLOWED[from]!.includes(to)) violations.push(`${rel} → ${to} (${spec})`);
      } else if (PURE.has(from) && FRAMEWORK.test(spec)) {
        violations.push(`${rel} imports UI framework ${spec}`);
      }
    }
  }
  it("no layer imports a layer it may not depend on", () => expect(violations).toEqual([]));
});
