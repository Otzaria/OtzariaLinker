import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * The history list in the real single file, offline: actions appear newest first with their
 * labels; choosing an entry undoes or redoes up to it, by mouse and by keyboard.
 */
const DB = resolve("tests/fixtures/db/seforim-v7-mini.db");
const SHOTS = process.env.SHOTS_DIR;
const COMMENTARY = { name: "פירוש על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from("<h1>פירוש על בראשית</h1>\nבראשית - פירוש ראשון\nויאמר - פירוש שני\n", "utf8") };

test("history list: newest first, jump back and forward, keyboard", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(DB) }, COMMENTARY]);
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: "פירוש על בראשית" }).getByRole("button", { name: "מקור" }).click();
  await books.filter({ hasText: /^בראשית/ }).first().getByRole("button", { name: "יעד" }).click();
  const source = page.locator(".reader.source");
  const target = page.locator(".reader.target");
  await expect(target.locator(".ln").nth(2)).toContainText("(א)", { timeout: 30_000 });

  const historyButton = page.getByRole("button", { name: "היסטוריית פעולות" });
  await historyButton.click();
  await expect(page.locator(".history-empty")).toContainText("עדיין לא בוצעו פעולות");
  await page.keyboard.press("Escape");

  // two links, then deleting one: three actions
  await source.locator('.ln[data-i="1"] .tx').click();
  await target.locator('.ln[data-i="2"] .tx').click();
  await page.keyboard.press("Control+Enter");
  await expect(source.locator('.ln[data-i="1"] .mark.new')).toHaveText("1");
  await source.locator('.ln[data-i="2"] .tx').click();
  await target.locator('.ln[data-i="3"] .tx').click();
  await page.keyboard.press("Control+Enter");
  await expect(source.locator('.ln[data-i="2"] .mark.new')).toHaveText("1");
  await page.getByRole("tab", { name: /קישורים/ }).click();
  await expect(page.locator(".link-item")).toHaveCount(2);
  await page.locator(".link-item").first().getByRole("button", { name: "מחיקה" }).click();
  await expect(source.locator(".mark.new")).toHaveCount(1);

  // newest first, the current one marked
  await historyButton.click();
  const items = page.getByRole("menuitemradio");
  await expect(items).toHaveCount(4); // three actions and "before all of them"
  await expect(items.nth(0)).toContainText("מחיקת קישור");
  await expect(items.nth(1)).toContainText("יצירת קישור");
  await expect(items.nth(2)).toContainText("יצירת קישור");
  await expect(items.nth(3)).toContainText("לפני כל הפעולות");
  await expect(items.nth(0)).toHaveAttribute("aria-checked", "true");
  await expect(items.nth(0)).toContainText(/\d\d:\d\d:\d\d/);

  // back to after the first link: one link, the later actions show as undone
  await items.nth(2).click();
  await expect(source.locator(".mark.new")).toHaveCount(1);
  await expect(source.locator('.ln[data-i="1"] .mark.new')).toHaveText("1");
  await historyButton.click();
  await expect(items.nth(2)).toHaveAttribute("aria-checked", "true");
  await expect(items.nth(0)).toHaveClass(/undone/);
  await expect(items.nth(0)).toContainText("בוטלה");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/history.png` });
  await expect(page.getByRole("button", { name: "ביצוע חוזר" })).toBeEnabled();

  // keyboard: the menu takes focus; arrows move, Enter chooses (forward to after the second link)
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(source.locator(".mark.new")).toHaveCount(2);

  // before everything, then all the way forward again
  await historyButton.click();
  await items.nth(3).click();
  await expect(source.locator(".mark.new")).toHaveCount(0);
  await historyButton.click();
  await items.nth(0).click();
  await expect(source.locator(".mark.new")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "ביצוע חוזר" })).toBeDisabled();

  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
