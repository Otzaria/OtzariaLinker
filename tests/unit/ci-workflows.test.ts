import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * What the CI runs (V7 §4.19, docs/RELEASE_PROCESS.md §4). A workflow cannot be run here, so these read the files: every
 * kind of check has its job or step, the heavy tests are manual only, WebKit is optional, and the report of skipped
 * tests fails on a skip that nothing explains. (No YAML parser is a dependency; the files were also checked with PyYAML.)
 */

const read = (p: string) => readFileSync(resolve(p), "utf8").replace(/\r\n/g, "\n");
const ci = read(".github/workflows/ci.yml");
const heavy = read(".github/workflows/heavy.yml");

/** The lines of a top-level job (`  name:`) up to the next job. */
function job(text: string, name: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^ {2}\S/.test(lines[i]!)) (end = i), (i = lines.length);
  return lines.slice(start, end).join("\n");
}
/** The commands of `run:` lines and blocks, comments removed. */
const runs = (text: string) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

describe("ci.yml", () => {
  it("runs on every push to main and every pull request", () => {
    expect(ci).toMatch(/^on:\n {2}push:\n {4}branches: \[main, "rewrite\/\*\*"\]\n {2}pull_request:/m);
  });

  it("has a job or step for every kind of check", () => {
    expect(runs(job(ci, "typecheck"))).toContain("npm run typecheck");
    expect(runs(job(ci, "security"))).toContain("npm audit --omit=dev");
    const tests = runs(job(ci, "tests"));
    for (const kind of ["unit", "integration", "contracts"]) expect(tests).toContain(`npx vitest run tests/${kind} `);
    expect(tests).toContain("FC_SEED=");
    expect(tests).toContain("node scripts/ci/skipped-tests.mjs reports/unit.json reports/integration.json reports/contracts.json");
    expect(runs(job(ci, "build"))).toContain("npm run build");
    expect(runs(job(ci, "visual"))).toContain("--config playwright.visual.config.ts");
  });

  it("E2E in Chrome, Edge and Firefox on the built file, each its own job", () => {
    const e2e = job(ci, "e2e");
    expect(e2e).toContain("needs: build");
    expect(e2e).toContain("fail-fast: false");
    for (const [project, install] of [["chrome", "chrome"], ["edge", "msedge"], ["firefox", "firefox"]]) {
      expect(e2e).toMatch(new RegExp(`- project: ${project}\\n\\s+install: ${install}\\n`));
    }
    expect(e2e).toContain("npx playwright test --project=${{ matrix.project }}");
    expect(e2e).toContain("name: e2e-dist");
  });

  it("WebKit only behind a repository variable, and never failing the run", () => {
    const w = job(ci, "e2e-webkit");
    expect(w).toContain("if: ${{ vars.E2E_WEBKIT == 'true' }}");
    expect(w).toContain("continue-on-error: true");
    expect(w).toContain('PW_WEBKIT: "1"');
  });

  it("the reproducible build compares the same commit built twice in one checkout and once in another", () => {
    const r = runs(job(ci, "reproducible"));
    expect(r).toContain("path: first");
    expect(r).toContain("path: second");
    expect(r).toContain('test "$(cat sha-first-1)" = "$(cat sha-first-2)"');
    expect(r).toContain('test "$(cat sha-first-1)" = "$(cat sha-second)"');
  });

  it("runs none of the heavy local-data suites", () => {
    expect(runs(ci)).not.toMatch(/validate:real|validate:browser|vitest\.validation\.config|local\.test/);
  });
});

describe("heavy.yml", () => {
  it("is manual only", () => {
    expect(heavy).toMatch(/^on:\n {2}workflow_dispatch:\n/m);
    expect(heavy).not.toMatch(/^ {2}(push|pull_request|schedule|workflow_run):/m);
  });

  it("runs the local-data tests, the validation and the browser validation, and reports what skipped", () => {
    const h = runs(job(heavy, "heavy"));
    expect(h).toContain("npx vitest run local.test");
    expect(h).toContain("--config vitest.validation.config.ts");
    expect(h).toContain("npm run validate:browser");
    expect(h).toContain("node scripts/ci/skipped-tests.mjs");
    expect(h).toContain('test -f "$OTZARIA_DB"');
  });
});

describe("playwright.config.ts", () => {
  afterAll(() => vi.unstubAllEnvs());
  const projects = async () => ((await import("../../playwright.config.ts")).default.projects ?? []).map((p) => p.name);

  it("has Chrome, Edge and Firefox, and WebKit only with PW_WEBKIT=1", async () => {
    vi.stubEnv("PW_WEBKIT", "");
    vi.resetModules();
    expect(await projects()).toEqual(["chrome", "edge", "firefox"]);
    vi.stubEnv("PW_WEBKIT", "1");
    vi.resetModules();
    expect(await projects()).toEqual(["chrome", "edge", "firefox", "webkit"]);
  });
});

describe("scripts/ci/skipped-tests.mjs", () => {
  const dir = mkdtempSync(join(tmpdir(), "skipped-tests-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const report = (files: Record<string, string[]>) => {
    const p = join(dir, `r${Math.random().toString(36).slice(2)}.json`);
    const testResults = Object.entries(files).map(([name, statuses]) => ({
      name: resolve(name),
      assertionResults: statuses.map((status, i) => ({ status, fullName: `t${i}` })),
    }));
    writeFileSync(p, JSON.stringify({ testResults }));
    return p;
  };
  const run = (reports: string[], env: Record<string, string | undefined> = {}) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OTZARIA_|V52_|GITHUB_STEP_SUMMARY$)/.test(k)));
    return spawnSync(process.execPath, ["scripts/ci/skipped-tests.mjs", ...reports], { encoding: "utf8", env: { ...clean, ...env } });
  };
  const LOCAL = "tests/integration/database/real-db.local.test.ts";
  const PLAIN = "tests/unit/ai/ai-review.test.ts";

  it("lists a skipped local-data file with the variable it is missing, and passes", () => {
    const r = run([report({ [LOCAL]: ["skipped", "skipped"], [PLAIN]: ["passed"] })]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`SKIPPED   2/2   ${LOCAL} — needs local data: OTZARIA_DB not set`);
    expect(r.stdout).toContain("Tests run: 1. Tests skipped: 2 in 1 file(s).");
  });

  it("fails when a local-data file skipped although its variable is set", () => {
    const r = run([report({ [LOCAL]: ["skipped"] })], { OTZARIA_DB: "/some/seforim.db" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${LOCAL}: 1 test(s) skipped although its data variables are set`);
  });

  it("fails on a skip in a file with no data gate and no explicit skip", () => {
    const r = run([report({ [PLAIN]: ["passed", "skipped"] })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no data gate and no explicit skip");
  });

  it("reads the validation helper's names (DB, LIBRARY) as their variables", () => {
    const r = run([report({ "tests/validation/library-texts.test.ts": ["skipped"] })], { OTZARIA_DB: "/x.db" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("needs local data: OTZARIA_LIBRARY not set (set: OTZARIA_DB)");
  });

  it("fails when a report is missing (the test step did not run)", () => {
    const r = run([join(dir, "missing.json")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no report");
  });
});
