import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../../../src/cli/main";
import type { RunReport } from "../../../src/cli/run";

/*
 * The built command (vite.cli.config.ts → dist-cli/linker.mjs), built here into a temporary folder and run with `node`, as a
 * user or a batch script runs it: the same report as the in-process run, the exit codes, and a bundle that needs nothing installed
 * (it is run from a folder with no node_modules next to it).
 */
let dir = "";
let bin = "";
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "linker-cli-"));
  await build({ configFile: "vite.cli.config.ts", logLevel: "silent", build: { outDir: dir, emptyOutDir: true } });
  bin = join(dir, "linker.mjs");
}, 120_000);
afterAll(() => dir && rmSync(dir, { recursive: true, force: true }));

const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", cwd: process.cwd(), timeout: 120_000 });

describe("dist-cli/linker.mjs", { timeout: 60_000 }, () => {
  it("is one file with its dependencies inside: only node: built-ins are imported", () => {
    const code = readFileSync(bin, "utf8");
    const specs = [...code.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]!);
    expect(specs.filter((s) => !/^(node:)?(fs|path|module|url|os|crypto|worker_threads|util)$/.test(s))).toEqual([]);
    console.info(`dist-cli/linker.mjs: ${statSync(bin).size} bytes`);
  });

  it("a dry run gives the report the in-process run gives, and exit 0", async () => {
    const args = ["--repo", "tests/fixtures/repos/unofficial-books", "--db", "tests/fixtures/db/seforim-v7-mini.db", "--dry-run", "--json", "--min-confidence", "high"];
    const r = run(args);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    let out = "";
    await main(args, { out: (t) => void (out += t), err: () => undefined });
    const a = JSON.parse(r.stdout) as RunReport;
    const b = JSON.parse(out) as RunReport;
    expect(a.files).toEqual(b.files);
    expect(a.suggestions).toEqual(b.suggestions);
    expect(a.files.length).toBeGreaterThan(0);
  });

  it("exit codes: 2 for wrong arguments, 1 for a failed run", () => {
    expect(run(["--nope"]).status).toBe(2);
    expect(run(["--repo", "tests/fixtures/repos/none", "--dry-run"]).status).toBe(1);
    expect(run(["--help"]).stdout).toMatch(/--repo/);
  });
});
