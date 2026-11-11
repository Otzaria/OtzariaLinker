import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

test("the single HTML file starts offline from file:// and its DB worker runs sql.js and zstd", async ({ page }) => {
  const seen = watchPage(page);
  await page.goto(distUrl);
  await expect(page.locator("html")).toHaveAttribute("data-engine", /^SQLite \d+\.\d+.* · בדיקת zstd$/);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
