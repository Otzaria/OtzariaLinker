import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * The citations engine ("מראי מקומות") in the real worker of the single file: a small text book that
 * cites בראשית, against the real database slice (its בראשית keeps the verses cited here: א, כח and
 * ב, יט — tests/fixtures/db, scripts/fixtures/make_mini_db.py). Only the source book is picked.
 */
test("citations: a text book's references are linked into the open database, then approved", async ({ page }) => {
  const seen = watchPage(page);
  const book = [
    "<h1>חיבור לדוגמה</h1>",
    "<h2>פרק א</h2>",
    "מצוה על פריה ורביה, שנאמר (בראשית א, כח) ויברך אתם.",
    "ואת שם החיות קרא האדם, כמו שכתוב בבראשית פרק ב פסוק יט.",
    "שורה בלי שום הפניה, וגם בראשית ברא אינה הפניה.",
  ].join("\n");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "חיבור לדוגמה.txt", mimeType: "text/plain", buffer: Buffer.from(book) },
  ]);
  await expect(page.locator(".source-row").first()).toBeVisible({ timeout: 30_000 });

  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: "חיבור לדוגמה" }).first().getByRole("button", { name: "מקור" }).click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "מראי מקומות" });
  await expect(page.getByText("לא צריך לבחור יעד")).toBeVisible();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();

  const rows = page.getByRole("table", { name: "הצעות" }).locator("tbody tr");
  await expect(rows.first()).toBeVisible({ timeout: 30_000 });
  await expect(rows).toHaveCount(2);
  await expect(page.getByRole("table", { name: "הצעות" })).toContainText("בראשית");
  await page.getByRole("button", { name: /אישור כל הוודאיות/ }).click();
  await expect(page.getByRole("tab", { name: /קישורים/ })).toContainText("2");
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
