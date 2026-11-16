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

/*
 * Wizard round V5: a database with no books says so (and why) instead of proposing a table; the
 * limitations are listed; manual mapping is still possible; "בדיקת המיפוי" shows the first lines of
 * the first books before anything is opened.
 */
test("a database without books: 'no books' with the reasons, nothing to open until mapped by hand", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "app.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/wizard/settings-log.db")) }]);

  const wizard = page.getByRole("dialog", { name: /איך לקרוא את המסד/ });
  await expect(wizard).toBeVisible({ timeout: 15_000 });
  await expect(wizard.locator(".map-nobooks")).toContainText("לא נמצאו ספרים במסד הזה.");
  await expect(wizard.locator(".map-summary")).toHaveCount(0);
  await expect(wizard.getByRole("button", { name: "פתיחה" })).toBeDisabled();
  // the reasons are open: the log table lost on its own evidence
  await expect(wizard.locator(".map-why")).toContainText('שם הטבלה ("log")');
  await expect(wizard.locator(".map-why")).toContainText("ערכים חוזרים");

  await wizard.getByRole("button", { name: "מיפוי ידני בכל זאת" }).click();
  await expect(wizard.getByLabel("טקסט השורה")).toBeVisible();
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("JSON chapters: the guess explains itself, the test shows the first lines, then open", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "chapters.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/wizard/json-chapters.db")) }]);

  const wizard = page.getByRole("dialog", { name: /איך לקרוא את המסד/ });
  await expect(wizard).toBeVisible({ timeout: 15_000 });
  await expect(wizard.locator(".map-summary")).toContainText("JSON של שורות ופרקים");
  await wizard.locator(".map-why summary").click();
  await expect(wizard.locator(".map-why")).toContainText("JSON של טקסט");

  await wizard.getByRole("button", { name: "בדיקת המיפוי" }).click();
  const result = wizard.getByRole("status", { name: "תוצאת בדיקת המיפוי" });
  await expect(result).toContainText("נמצאו 2 ספרים.");
  await expect(result.locator(".map-test-book").nth(1)).toContainText("פרק א");
  await expect(result.locator(".map-test-book").nth(1).locator("li.heading")).toHaveCount(2); // פרק א, פרק ב within the first 6 lines

  await wizard.getByRole("button", { name: "פתיחה" }).click();
  await expect(wizard).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".source-row")).toHaveCount(1);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
