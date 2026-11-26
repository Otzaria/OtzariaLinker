import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type Plugin } from "vite";
import { afterAll, describe, expect, it } from "vitest";

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

/*
 * V7 PR4 review (licences): the two other bundles, dist-cli/linker.mjs and dist-plugin/otzaria-linker-core.js, are copies of
 * the program too, and the CLI bundles preact, @preact/signals(-core), fflate and the zstd decoder with its WASM. Each is built
 * here with a probe that records the modules that went into it (independent of the plugin that writes the notice); the file
 * must carry the program's GPL notice and, for every package one of those modules comes from, that package's notice.
 */
const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** the package a module id comes from: a node_modules path, or the package path of a virtual:wasm-b64 id */
const packageOf = (id: string) =>
  /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id)?.[1]?.replace("\\", "/") ?? /virtual:wasm-b64\/((?:@[^/]+\/)?[^/]+)\//.exec(id)?.[1];
const versionOf = (pkg: string) => (JSON.parse(readFileSync(join("node_modules", pkg, "package.json"), "utf8")) as { version: string }).version;

async function built(configFile: string, file: string): Promise<{ code: string; packages: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "linker-licences-"));
  tmp.push(dir);
  const ids = new Set<string>();
  const probe: Plugin = {
    name: "test:module-probe",
    generateBundle(_, bundle) {
      for (const c of Object.values(bundle)) if (c.type === "chunk") for (const id of c.moduleIds) ids.add(id);
    },
  };
  await build({ configFile, logLevel: "silent", build: { outDir: dir, emptyOutDir: true }, plugins: [probe] });
  const packages = [...new Set([...ids].map(packageOf).filter((p): p is string => !!p))].sort();
  return { code: readFileSync(join(dir, file), "utf8"), packages };
}

describe("the licence notices in the CLI and plugin bundles", { timeout: 120_000 }, () => {
  for (const [configFile, file, atLeast] of [
    ["vite.cli.config.ts", "linker.mjs", ["@preact/signals-core", "fflate", "zstd-wasm-decoder"]],
    ["vite.plugin.config.ts", "otzaria-linker-core.js", []],
  ] as const) {
    it(`${configFile}: the program's notice, and the notice of every package it bundles`, async () => {
      const { code, packages } = await built(configFile, file);
      expect(packages).toEqual(expect.arrayContaining([...atLeast]));
      expect(code).toContain("GNU General Public License");
      const missing = packages.filter((pkg) => !code.includes(`----- ${pkg}@${versionOf(pkg)} -----`));
      expect(missing, `packages bundled in ${file} without their notice`).toEqual([]);
      // the CLI is run as `node linker.mjs`: the notice is a comment that does not break the module
      if (file.endsWith(".mjs")) expect(code).toMatch(/^\/\*!/);
    });
  }
});
