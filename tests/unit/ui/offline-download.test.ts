import { describe, expect, it } from "vitest";
import { offlineDownloadText } from "../../../src/ui/shell/offline-download";

/*
 * V7 spec §4.21 (issue #26): there are three ways to get the tool — the latest stable Release (the permanent
 * releases/latest/download link), the GitHub Pages copy (built from every green commit of main) and the
 * per-version file of a Release. The in-app button downloads the Pages copy: the same file as the page that is
 * open, so it can never be older than what the user sees — but it did not say WHICH version that is, so a
 * development build of main looked like a release. The button now names the version it downloads, and says when
 * it is a development (pre-release) build and where the stable one is.
 */
describe("the offline download button names the version it downloads", () => {
  it("a pre-release (the Pages build of main) is called a development build, with its commit, and points at Releases for a stable one", () => {
    const t = offlineDownloadText("4.0.0-alpha.0", "e9bdad1c0ffe");
    expect(t.badge).toBe("גרסת פיתוח 4.0.0-alpha.0");
    expect(t.title).toContain("4.0.0-alpha.0");
    expect(t.title).toContain("e9bdad1c0ffe");
    expect(t.title).toContain("אותה גרסה שפתוחה כאן");
    expect(t.title).toContain("Releases");
  });

  it("a stable version is named as a version, not as a development build", () => {
    const t = offlineDownloadText("4.0.0", "0123456789ab");
    expect(t.badge).toBe("גרסה 4.0.0");
    expect(t.title).toContain("4.0.0");
    expect(t.title).not.toContain("פיתוח");
  });

  it("a build without version information (tests, dev server) still says what the file is", () => {
    const t = offlineDownloadText(undefined, undefined);
    expect(t.badge).toBe("");
    expect(t.title).toContain("אותה גרסה שפתוחה כאן");
  });
});
