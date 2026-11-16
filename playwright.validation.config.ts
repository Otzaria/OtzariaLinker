import { defineConfig } from "@playwright/test";

/*
 * Check 8 of the real-data validation (docs/validation/REAL_DATA_REPORT.md): the BUILT single file,
 * offline from file://, in the installed Chrome, opening the real 4.5 GB seforim.db through the file
 * chooser. Skipped without OTZARIA_DB. Build first:
 *   npm run build && OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npm run validate:browser
 */
export default defineConfig({
  testDir: "tests/validation/browser",
  timeout: 600_000,
  reporter: [["list"]],
  use: { offline: true, locale: "he-IL", trace: "off" },
  projects: [{ name: "chrome", use: { channel: "chrome" } }],
});
