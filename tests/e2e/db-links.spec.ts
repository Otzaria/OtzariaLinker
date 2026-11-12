import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * Database links (stage 10) on the built file, offline: open the real schema-7 slice, list a book's
 * links from the database, filter by the other book, copy one into the project, and export it —
 * first held back (the book's links file is not loaded and would be replaced), then written once
 * the user confirms the library has no file. The record is compared with the library's real one
 * (pninimToOtzaria/links/ארצות החיים_links.json @aa2c293b: 323 → 1307, start 33, commentary).
 */
test("browse a book's database links, filter, copy one, export it with the replacement warning", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) }]);

  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: /^ארצות החיים/ }).getByRole("button", { name: "מקור" }).click({ timeout: 30_000 });
  await expect(page.locator(".reader.source h2")).toHaveText("ארצות החיים");

  await page.getByRole("tab", { name: /קישורים/ }).first().click();
  await page.getByRole("tab", { name: /קישורים מהמסד/ }).click();
  const panel = page.locator(".dbl");
  await expect(panel.locator(".dbl-sum")).toContainText("6 קישורים במסד");
  await expect(panel.getByText("קריאה בלבד")).toBeVisible();

  // group by the other book → filter
  await panel.locator(".dbl-book").filter({ hasText: "המאיר לארץ על ארצות החיים" }).click();
  await expect(panel.locator(".bulk .muted")).toHaveText("3 קישורים");
  const items = panel.getByRole("list", { name: "קישורים מהמסד" }).locator(".dbl-item");
  await expect(items).toHaveCount(3);
  await expect(items.first()).toContainText("ארצות החיים 323");
  await expect(items.first()).toContainText("ספריית אוצריא");

  // a click shows both ends: the listed book stays in the source reader
  await items.first().click();
  await expect(page.locator(".reader.target h2")).toHaveText("המאיר לארץ על ארצות החיים");
  await expect(page.locator(".reader.source h2")).toHaveText("ארצות החיים");

  // by type, then copy the first link into the project
  await panel.getByRole("tab", { name: /לפי סוג/ }).click();
  await panel.getByRole("button", { name: /^פירוש 6/ }).click();
  await expect(items).toHaveCount(3);
  await items.first().getByRole("checkbox", { name: "סימון להעתקה" }).check();
  await panel.getByRole("button", { name: "העתקה לפרויקט (1)" }).click();
  await expect(page.getByText(/הקישור הועתק לפרויקט/)).toBeVisible();
  await expect(items.first()).toContainText("כבר בפרויקט");

  await page.getByRole("tab", { name: /קישורי הפרויקט/ }).click();
  await expect(page.locator(".link-item")).toHaveCount(1);
  await expect(page.locator(".link-item .status")).toHaveText("הועתק מהמסד");

  // export: held back until the book's links file is loaded — or the user says there is none
  await page.getByRole("button", { name: /ייצוא/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".dbcopy-files")).toContainText("ארצות החיים_links.json");
  await expect(dialog).toContainText("1 קישורים לא ייוצאו");
  await expect(dialog.getByRole("button", { name: /הורדת/ }).last()).toBeDisabled();
  await dialog.getByRole("button", { name: "אין לספר קובץ בספרייה" }).click();
  await expect(dialog.locator(".dbcopy-files")).toHaveCount(0);
  await expect(dialog.locator(".files")).toContainText("ארצות החיים_links.json");
  await expect(dialog.locator(".files")).toContainText("קובץ חדש");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "הורדת הקובץ" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("ארצות החיים_links.json");
  const records = JSON.parse(readFileSync(await file.path(), "utf8")) as Record<string, unknown>[];
  expect(records).toEqual([{ line_index_1: 323, heRef_2: "המאיר לארץ על ארצות החיים 1307", path_2: "המאיר לארץ על ארצות החיים.txt", line_index_2: 1307, start: 33, "Conection Type": "commentary" }]);

  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
