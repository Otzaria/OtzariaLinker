import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * "This passage continues the previous one" (V7 §2.13, issue #44) in the real single file, offline: the builder's
 * button shows a preview, the confirmation is one undoable step, the link says where it was continued from, and its
 * cancel undoes only that. Keyboard only after the line picks.
 */
const DB = resolve("tests/fixtures/db/seforim-v7-mini.db");
const COMMENTARY = { name: "פירוש על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from("<h1>פירוש על בראשית</h1>\nבראשית - פירוש ראשון\nהמשך הפירוש הראשון\nויאמר - פירוש שני\n", "utf8") };

test("continue the previous passage: preview, confirm, show the origin, cancel", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(DB) }, COMMENTARY]);
  await expect(page.locator(".source-row")).toHaveCount(2, { timeout: 30_000 });

  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: "פירוש על בראשית" }).locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  const source = page.locator(".reader.source");
  const target = page.locator(".reader.target");
  await expect(source.locator(".ln").nth(2)).toContainText("המשך הפירוש");

  await source.locator('.ln[data-i="1"] .tx').click();
  await target.locator('.ln[data-i="2"] .tx').click();
  const builder = page.locator(".builder");
  await builder.getByPlaceholder("Genesis 1:1").fill("Genesis 1:1");
  await page.keyboard.press("Control+Enter");
  await expect(source.locator('.ln[data-i="2"]')).toHaveClass(/picked/); // the source advanced to the next line

  const button = builder.getByRole("button", { name: /המשך לקטע הקודם/ });
  await button.focus();
  await page.keyboard.press("Enter");
  const preview = builder.getByRole("group", { name: /תצוגה מקדימה/ });
  await expect(preview).toContainText("המשך של שורה 2");
  await expect(preview).toContainText("טווחים יורחבו");
  await preview.getByRole("button", { name: "אישור" }).focus();
  await page.keyboard.press("Enter");
  await expect(preview).toHaveCount(0);

  await page.getByRole("tab", { name: /קישורים/ }).click();
  const item = page.locator(".link-item");
  await expect(item).toHaveCount(1);
  await expect(item).toContainText("2–3");
  await expect(item).toContainText("הורחב כהמשך של שורה 2");
  await item.getByRole("button", { name: "ביטול ההמשך" }).click();
  await expect(item).not.toContainText("2–3");
  await expect(item.locator(".continued")).toHaveCount(0);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
