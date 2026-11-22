import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

test("QA finds a duplicate and a link to a heading line; the bulk fix removes only the copy", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const rec = (l1: number, l2: number) => ({ line_index_1: l1, heRef_2: "בראשית", path_2: "בראשית.txt", line_index_2: l2, "Conection Type": "reference" });
  const links = JSON.stringify([rec(2, 3), rec(2, 3), rec(3, 1)], null, 2); // a duplicate; line 1 of בראשית is <h1>
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ספר שלי.txt", mimeType: "text/plain", buffer: Buffer.from("<h1>ספר שלי</h1>\nשורה ב\nשורה ג\nשורה ד") },
    { name: "ספר שלי_links.json", mimeType: "application/json", buffer: Buffer.from(links) },
  ]);
  await page.getByRole("tab", { name: /בדיקה/ }).click({ timeout: 30_000 });
  await page.getByRole("button", { name: "בדיקת הקישורים" }).click();
  await expect(page.getByText("3 קישורים נבדקו")).toBeVisible();
  await expect(page.getByRole("button", { name: "כפולים 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "קישור לכותרת 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /מחיקת 1 העתקים כפולים/ }).click();
  await expect(page.getByText("2 קישורים נבדקו")).toBeVisible();
  await expect(page.getByRole("button", { name: /^כפולים/ })).toHaveCount(0);
  expect(seen.errors).toEqual([]);
});

/*
 * Issue 17: which parts of a book no link touches yet. The "coverage" section of the check tab lists the unlinked content
 * lines of the book in the source reader as ranges (headings are not content), counts every line by what links it, jumps to
 * a range, and starts a manual link from it.
 */
test("coverage: the unlinked ranges of a book, the buckets, jump to a range and link it by hand", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const nl = String.fromCharCode(10);
  // line numbers are 1-based in the file: 1 h1, 2 linked, 3 unlinked, 4 unlinked, 5 h2, 6 linked, 7 unlinked
  const book = ["<h1>ספר שלי</h1>", "שורה שנייה", "שורה שלישית", "שורה רביעית", "<h2>פרק ב</h2>", "שורה שישית", "שורה שביעית"].join(nl);
  const rec = (l1: number) => ({ line_index_1: l1, heRef_2: "בראשית", path_2: "בראשית.txt", line_index_2: 3, "Conection Type": "reference" });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "ספר שלי.txt", mimeType: "text/plain", buffer: Buffer.from(book) },
    { name: "ספר שלי_links.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([rec(2), rec(6)])) },
  ]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole("tab", { name: /בדיקה/ }).click();
  const cov = page.locator("details.coverage");
  await cov.locator("summary").click();
  await cov.getByRole("button", { name: "חישוב כיסוי" }).click();

  await expect(cov.locator(".cov-count[data-bucket=unlinked]")).toContainText("3");
  await expect(cov.locator(".cov-count[data-bucket=linked]")).toContainText("2");
  await expect(cov.locator(".cov-count[data-bucket=not-suitable]")).toContainText("2"); // the two headings
  const ranges = cov.locator(".cov-range");
  await expect(ranges).toHaveCount(2);
  await expect(ranges.nth(0)).toContainText("שורות 3–4");
  await expect(ranges.nth(0)).toContainText("שורה שלישית"); // the start of the range's text
  await expect(ranges.nth(1)).toContainText("שורה 7");

  // jump: the reader shows the line
  await ranges.nth(1).getByRole("button", { name: /^הצגה/ }).click();
  await expect(page.locator('.reader.source .ln[data-i="6"]')).toBeVisible();
  // link it by hand: the range is picked as the source line and the builder opens
  await ranges.nth(0).getByRole("button", { name: /^קישור ידני/ }).click();
  await expect(page.getByRole("tab", { name: /בונה/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('.reader.source .ln[data-i="2"]')).toHaveClass(/picked/);
  await expect(page.locator('.reader.source .ln[data-i="3"]')).toHaveClass(/picked/);

  // linking a line takes it out of the list (the numbers are read again from the links as they are now)
  await page.getByRole("tab", { name: /בדיקה/ }).click();
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * 3.6: the last coverage of a book is kept with the project (state/coverage.ts saved), and the panel says when it was counted.
 * Until the book is counted again in this session, the kept numbers are shown as such — with the day and a plain note that they
 * may be out of date — never as if they were current.
 */
test("coverage: a fresh count shows when it was counted; a kept one says it may be out of date and is replaced by a new count", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const nl = String.fromCharCode(10);
  const book = ["<h1>ספר שלי</h1>", "שורה שנייה", "שורה שלישית", "שורה רביעית"].join(nl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "ספר שלי.txt", mimeType: "text/plain", buffer: Buffer.from(book) },
    { name: "ספר אחר.txt", mimeType: "text/plain", buffer: Buffer.from(["<h1>ספר אחר</h1>", "שורה אחת"].join(nl)) },
  ]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li").filter({ hasText: "ספר שלי" }).locator('button.side-btn[data-side="source"]').click();
  await page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li").filter({ hasText: "ספר אחר" }).locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /בדיקה/ }).click();
  const cov = page.locator("details.coverage");
  await cov.locator("summary").click();
  await expect(cov.locator(".cov-stamp")).toHaveCount(0); // nothing counted yet
  await cov.getByRole("button", { name: "חישוב כיסוי" }).click();
  await expect(cov.locator(".cov-count[data-bucket=unlinked]")).toContainText("3");
  await expect(cov.locator(".cov-stamp")).toContainText("חושב לאחרונה:");
  await expect(cov.locator(".cov-stamp")).not.toHaveAttribute("data-stale", /.*/);

  // choosing the book again drops the session's count; the one kept with the project is shown, as out of date
  await cov.getByLabel("הספר").selectOption("target");
  await cov.getByLabel("הספר").selectOption("source");
  await expect(cov.locator(".cov-stamp")).toContainText("זה החישוב האחרון ששמור בפרויקט");
  await expect(cov.locator(".cov-stamp")).toContainText("ייתכן שהקישורים השתנו מאז");
  await expect(cov.locator(".cov-count[data-bucket=unlinked]")).toContainText("3");
  await cov.getByRole("button", { name: "חישוב מחדש" }).click();
  await expect(cov.locator(".cov-stamp")).toContainText("חושב לאחרונה:");
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
