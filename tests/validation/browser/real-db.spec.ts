import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "../../e2e/helpers";

/*
 * Check 8 — the real seforim.db (4.5 GB) through the file chooser of the built single file, in Chrome,
 * offline: the database opens, the book list has every book, and a large book shows its text. The
 * file is handed to the browser BY PATH (Playwright's setFiles), so the page reads it with
 * File.slice like a user's file — nothing is copied into memory.
 *   npm run build && OTZARIA_DB=C:/ProgramData/otzaria/books/seforim.db npm run validate:browser
 */
const DB = process.env.OTZARIA_DB;

test.skip(!DB, "needs OTZARIA_DB");

test("the real seforim.db opens through the file chooser and a book shows its text", async ({ page }) => {
  const seen = watchPage(page);
  const timings: Record<string, number | string> = { dbBytes: statSync(DB!).size };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  const t0 = Date.now();
  await (await chooser).setFiles(DB!);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 120_000 });
  timings.openMs = Date.now() - t0;
  await expect(page.locator(".source-row")).toContainText("seforim.db");

  // the book list's search, then the book as the source: a large book with notes
  const list = page.getByRole("region", { name: "מקורות וספרים" });
  const reader = page.locator(".reader.source");
  const open = async (title: string) => {
    await list.getByRole("searchbox", { name: "חיפוש ספר" }).fill(title);
    await list.locator(".book-list li").filter({ hasText: new RegExp(`^${title}`) }).first().getByRole("button", { name: "מקור" }).click();
    await expect(reader.locator(".ln").nth(3)).not.toBeEmpty({ timeout: 120_000 });
  };
  const t1 = Date.now();
  await open("משנה ברורה");
  timings.firstBookMs = Date.now() - t1;
  timings.firstBookLinesRendered = await reader.locator(".ln").count();

  // the largest book of the library (190,453 lines)
  const t2 = Date.now();
  await open("דור המלקטים על אורח חיים");
  timings.largestBookMs = Date.now() - t2;

  if (process.env.VALIDATION_OUT) {
    mkdirSync(process.env.VALIDATION_OUT, { recursive: true });
    writeFileSync(join(process.env.VALIDATION_OUT, "browser.json"), JSON.stringify({ ...timings, errors: seen.errors, external: seen.external }, null, 2));
  }
  console.info(JSON.stringify(timings));
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
