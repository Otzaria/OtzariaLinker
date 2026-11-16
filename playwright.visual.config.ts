import { defineConfig } from "@playwright/test";

/*
 * Visual regression (docs/TESTING.md §2a): screenshots of the screens and dialogs of the BUILT single
 * file, offline from file://, at three widths, each in light and dark. Runs in CI (ci.yml, job
 * "visual", on windows-latest) against the committed baselines, tests/visual/__screenshots__/win32/.
 * What keeps a shot identical from one Windows machine to another:
 *   - the browser is Playwright's own Chromium headless shell, pinned by the @playwright/test version
 *     (not the installed Chrome, which updates by itself and differs between machines);
 *   - every system font the CSS names is shadowed by one embedded font (tests/visual/stable.ts), and
 *     each shot checks that no other system font drew any text;
 *   - grayscale anti-aliasing (--disable-lcd-text: ClearType's subpixel colours depend on the machine's
 *     settings), software rendering (--disable-gpu), sRGB, device scale factor 1, no animations.
 *   npm run test:visual                           # build + compare
 *   npm run test:visual -- --update-snapshots=all # after an intended UI change: rewrite, then LOOK at the diff
 */
export default defineConfig({
  testDir: "tests/visual",
  timeout: 90_000,
  fullyParallel: true,
  reporter: [["list"]],
  // in CI a missing baseline fails without writing one (a baseline nobody looked at checks nothing),
  // and the runner's 4 cores all run tests (the default is half)
  updateSnapshots: process.env.CI ? "none" : "missing",
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 4 : undefined,
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}", // win32/<width>/<screen>-<theme>.png
  expect: {
    // no pixel budget: a ratio as small as 0.2% let a changed button label (a few hundred pixels)
    // through. The per-pixel colour `threshold` (default 0.2) absorbs anti-aliasing noise.
    toHaveScreenshot: { maxDiffPixels: 0, animations: "disabled", caret: "hide", scale: "css" },
  },
  use: {
    browserName: "chromium", // the headless shell of `npx playwright install chromium-headless-shell`
    launchOptions: { args: ["--disable-lcd-text", "--disable-gpu", "--force-color-profile=srgb", "--disable-font-subpixel-positioning"] },
    offline: true,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
    trace: "off",
  },
  // one project: the widths are describe blocks of the spec (a project per width started a new set of
  // workers for each), and each shot is taken in light and then in dark — the app follows
  // prefers-color-scheme live, so a screen is reached once for both themes
  projects: [{ name: "chromium", use: { colorScheme: "light" } }],
});
