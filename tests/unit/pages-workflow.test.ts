import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// pages.yml deploys what a finished CI run built. The trigger's `branches: [main]` filters by the head branch NAME, which a
// fork's pull request branch can have too, so the job itself must refuse a run that is not a push of this repository,
// and the write permissions must belong to the deploy job only (the build job runs npm on the checked-out commit).
const text = readFileSync(new URL("../../.github/workflows/pages.yml", import.meta.url), "utf8");

/** The lines of a top-level job (`  build:`) up to the next job. */
function job(name: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start).toBeGreaterThan(-1);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("pages.yml", () => {
  it("builds a workflow_run only when it is a push of this repository", () => {
    const cond = /^\s{4}if: (.*)$/m.exec(job("build"))?.[1] ?? "";
    expect(cond).toContain("github.event.workflow_run.event == 'push'");
    expect(cond).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
    expect(cond).toContain("github.event.workflow_run.conclusion == 'success'");
  });

  it("has no write permission outside the deploy job", () => {
    const head = text.slice(0, text.indexOf("\njobs:"));
    expect(head).not.toMatch(/(pages|id-token|contents): write/);
    expect(job("build")).not.toMatch(/: write/);
    expect(job("deploy")).toMatch(/pages: write/);
    expect(job("deploy")).toMatch(/id-token: write/);
  });
});
