import { defineConfig } from "@playwright/test";

/*
 * E2E runs against the BUILT single file (dist/OtzariaLinker.html) opened from file://, with the
 * network switched off — exactly how users run it. Chrome and Edge are the installed browsers
 * (channel); Firefox is Playwright's own build (`npx playwright install firefox`).
 *
 * WebKit is optional and OFF unless PW_WEBKIT=1: its browser is a separate download
 * (`npx playwright install --with-deps webkit`), and whether the single file runs in it from file:// (a classic
 * worker from blob:, the embedded WASM) has not been established. CI runs it only when the repository variable
 * E2E_WEBKIT is "true", as a job that does not fail the run (docs/TESTING.md §2).
 */
const webkit = process.env.PW_WEBKIT === "1";

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
    ...(webkit ? [{ name: "webkit", use: { browserName: "webkit" as const }, testIgnore: /legacy-baseline/ }] : []),
  ],
});
