import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
    // `import … from "x"`, a bare `import "x"` and a dynamic `import("x")` (review M8: only the first was read)
    for (const spec of specifiers(text).map((s) => s.spec)) {
      const rel = relative(SRC, file);
      // the user guide, bundled as text for the help dialog: data, not code
      if (from === "ui" && /\?raw$/.test(spec) && relative(resolve("docs"), resolve(file, "..", spec.replace(/\?raw$/, ""))).match(/^[^.\\/][^\\/]*\.md$/)) continue;
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

/** every module specifier in a file; `typeOnly` when nothing of it exists at run time */
function specifiers(text: string): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = [];
  for (const m of text.matchAll(/^\s*(import|export)\s+(type\s+)?([^'";]*?)\bfrom\s+["']([^"']+)["']/gm)) {
    const clause = m[3]!;
    const braces = /^\s*\{([^}]*)\}\s*$/.exec(clause);
    const allTypes = !!braces && braces[1]!.split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "));
    out.push({ spec: m[4]!, typeOnly: !!m[2] || allTypes });
  }
  for (const m of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) out.push({ spec: m[1]!, typeOnly: false });
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push({ spec: m[1]!, typeOnly: false });
  return out;
}

/*
 * No import cycles at run time (review M8). A cycle makes the load order decide which module sees the
 * other half-initialised; type-only imports are erased and do not count (the state modules' Host
 * interfaces name the store that way on purpose).
 */
describe("no import cycles", () => {
  const resolveTs = (from: string, spec: string): string | null => {
    const base = resolve(from, "..", spec.replace(/\.js$/, ""));
    for (const c of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) if (existsSync(c)) return c;
    return null;
  };
  const graph = new Map<string, string[]>();
  for (const file of files(SRC)) {
    const deps = specifiers(readFileSync(file, "utf8"))
      .filter((s) => !s.typeOnly && s.spec.startsWith("."))
      .map((s) => resolveTs(file, s.spec))
      .filter((p): p is string => !!p);
    graph.set(file, deps);
  }
  // Tarjan's strongly connected components: each one of more than one module is a cycle
  const cycles: string[][] = [];
  let next = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (v: string): void => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) visit(w), low.set(v, Math.min(low.get(v)!, low.get(w)!));
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) !== index.get(v)) return;
    const scc: string[] = [];
    let w: string;
    do (w = stack.pop()!), onStack.delete(w), scc.push(relative(SRC, w).split(sep).join("/"));
    while (w !== v);
    if (scc.length > 1) cycles.push(scc.sort());
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);

  it("reads the imports it should (a sanity floor on the graph)", () => {
    expect(graph.size).toBeGreaterThan(200);
    expect([...graph.values()].reduce((n, d) => n + d.length, 0)).toBeGreaterThan(500); // 215 modules, 678 runtime imports on 2026-11-16
  });
  it("no module reaches itself through runtime imports", () => expect(cycles).toEqual([]));
});
