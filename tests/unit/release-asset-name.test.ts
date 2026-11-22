import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OFFLINE_FILE, offersOfflineDownload } from "../../src/ui/shell/offline-download";

/*
 * The README's permanent download link answered 404 (issue 26c): GitHub's releases/latest points at the latest
 * NON-pre-release, and until a stable 4.x release exists that is v3, which has no asset of this name. The
 * names must not drift apart again: the release workflow's asset, the Pages copy and the in-app link are one
 * file name, and the docs must not promise a permanent link they cannot yet keep.
 */
const read = (p: string) => readFileSync(p, "utf8");

describe("one asset name for the release, the Pages copy and the in-app download link", () => {
  it("the in-app link uses the file the release workflow uploads and the Pages workflow publishes", () => {
    expect(OFFLINE_FILE).toBe("OtzariaLinker.html");
    expect(read(".github/workflows/release.yml")).toContain(`dist/${OFFLINE_FILE}`);
    expect(read(".github/workflows/pages.yml")).toContain(`_site/${OFFLINE_FILE}`);
  });

  it("the control is offered over http(s) only", () => {
    expect([offersOfflineDownload("https:"), offersOfflineDownload("http:")]).toEqual([true, true]);
    expect([offersOfflineDownload("file:"), offersOfflineDownload("blob:"), offersOfflineDownload("data:")]).toEqual([false, false, false]);
  });

  it("every permanent releases/latest link in the docs names that file, and the README says when it works", () => {
    const readme = read("README.md");
    for (const f of ["README.md", "docs/RELEASE_PROCESS.md"]) {
      for (const m of read(f).matchAll(/releases\/latest\/download\/([^\s)`"']+)/g)) expect(m[1], `${f}`).toBe(OFFLINE_FILE);
    }
    // the README must not present the permanent link as working before a stable release: it points to the
    // Releases page (and the hosted page) first, and mentions the condition
    expect(readme).toMatch(/pre-release/);
    expect(readme.indexOf("github.com/Otzaria/OtzariaLinker/releases)")).toBeGreaterThanOrEqual(0);
    expect(readme.indexOf("github.com/Otzaria/OtzariaLinker/releases)")).toBeLessThan(readme.indexOf("releases/latest/download"));
  });
});
