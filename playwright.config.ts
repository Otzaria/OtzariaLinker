import { defineConfig } from "@playwright/test";

/*
 * E2E runs against the BUILT single file (dist/OtzariaLinker.html) opened from file://, with the
 * network switched off — exactly how users run it. Chrome and Edge are the installed browsers
 * (channel); Firefox is Playwright's own build (`npx playwright install firefox`).
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
    { name: "firefox", use: { browserName: "firefox" }, testIgnore: /legacy-baseline/ },
  ],
});
