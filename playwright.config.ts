import { defineConfig } from "@playwright/test";

/*
 * E2E runs against the BUILT single file (dist/OtzariaLinker.html) opened from file://, with the
 * network switched off — exactly how users run it. Uses the installed Chrome and Edge
 * (channel), so no browser download is needed.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: { offline: true, locale: "he-IL", trace: "retain-on-failure" },
  projects: [
    { name: "chrome", use: { channel: "chrome" } },
    { name: "edge", use: { channel: "msedge" } },
  ],
});
