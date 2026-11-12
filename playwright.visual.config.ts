import { defineConfig } from "@playwright/test";

/*
 * Visual regression (docs/TESTING.md §2א): screenshots of the main screens of the BUILT single file,
 * offline from file://, in the installed Chrome, in light and dark at three widths. Not part of
 * `npx playwright test` (its testDir is tests/e2e) nor of CI's default run: the UI font is the
 * system's ("Segoe UI" on Windows, something else on Linux), so a baseline is only valid on the
 * platform that made it. The baselines live per platform, under tests/visual/__screenshots__/<platform>/.
 *   npm run test:visual                       # build + compare
 *   npm run test:visual -- --update-snapshots=all # after an intended UI change: rewrite, then LOOK at the diff
 */
const WIDTHS = [
  { name: "desktop", viewport: { width: 1280, height: 800 } },
  { name: "tablet", viewport: { width: 768, height: 1024 } },
  { name: "phone", viewport: { width: 390, height: 844 } },
] as const;
const THEMES = ["light", "dark"] as const;

export default defineConfig({
  testDir: "tests/visual",
  timeout: 90_000,
  fullyParallel: true,
  reporter: [["list"]],
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{projectName}/{arg}{ext}",
  expect: {
    // no pixel budget: a ratio as small as 0.2% let a changed button label (a few hundred pixels)
    // through. The per-pixel colour `threshold` (default 0.2) absorbs anti-aliasing noise.
    toHaveScreenshot: { maxDiffPixels: 0, animations: "disabled", caret: "hide", scale: "css" },
  },
  use: {
    channel: "chrome",
    offline: true,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    trace: "off",
  },
  projects: THEMES.flatMap((theme) =>
    WIDTHS.map(({ name, viewport }) => ({ name: `${theme}-${name}`, use: { colorScheme: theme, viewport } })),
  ),
});
