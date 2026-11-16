import { execSync } from "node:child_process";

/** Version, commit and date baked into the bundle. The date is the commit date, not "now",
 *  so that building the same commit twice yields a byte-identical HTML file. */
export function buildInfo(version: string) {
  const git = (cmd: string) => {
    try { return execSync(`git ${cmd}`, { encoding: "utf8" }).trim(); } catch { return ""; }
  };
  const commit = process.env.GITHUB_SHA || git("rev-parse HEAD") || "unknown";
  const date = git("log -1 --format=%cI") || "1970-01-01T00:00:00Z";
  const dirty = process.env.GITHUB_SHA ? false : git("status --porcelain").length > 0;
  return {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit.slice(0, 12) + (dirty ? "-dirty" : "")),
    __APP_BUILD_DATE__: JSON.stringify(date),
  };
}
