import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * A SQLite database in someone else's schema, in the real single file, offline from file://:
 * drop it → the mapping wizard shows what it found → open → the books and their lines are readable.
 */
test("drop a non-Otzaria database → wizard → open → see its lines", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "corpus.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/generic/books-lines.db")) }]);

  const wizard = page.getByRole("dialog", { name: /איך לקרוא את המסד/ });
  await expect(wizard).toBeVisible({ timeout: 15_000 });
  await expect(wizard.locator(".map-summary")).toContainText('ספרים מ"works"');
  await expect(wizard.locator(".map-sample th.mapped")).toHaveCount(4); // work_id, seq, body, level

  // the fields are one click away, and a wrong choice blocks opening with a reason
  await wizard.getByRole("button", { name: "שינוי המיפוי" }).click();
  await wizard.getByLabel("טקסט השורה").selectOption("level");
  await expect(wizard.locator(".problems .warning")).toContainText("מספרים");
  await wizard.getByLabel("טקסט השורה").selectOption("");
  await expect(wizard.getByRole("button", { name: "פתיחה" })).toBeDisabled();
  await wizard.getByLabel("טקסט השורה").selectOption("body");

  await wizard.getByRole("button", { name: "פתיחה" }).click();
  await expect(wizard).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".source-row")).toHaveCount(1);
  await expect(page.locator(".source-row")).toContainText("מסד ממופה");

  // commentary ← base, chosen from the titles; lines in `seq` order, not in rowid order
  const target = page.locator(".reader.target");
  await expect(target.locator(".ln").first()).toContainText("ספר הדוגמה", { timeout: 15_000 });
  await expect(target.locator(".ln")).toHaveCount(12);
  await expect(page.locator(".reader.source .ln")).toHaveCount(6);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
