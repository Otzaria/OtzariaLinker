import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

test("the single HTML file starts offline from file:// and its DB worker runs sql.js", async ({ page }) => {
  const seen = watchPage(page);
  await page.goto(distUrl);
  await expect(page.locator("#engine")).toHaveText(/^SQLite \d+\.\d+/);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
