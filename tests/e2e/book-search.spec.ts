import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * Search inside a book, in the real single file, offline: Ctrl+F in a reader, a query typed without
 * nikud finds the pointed text, Enter / Shift+Enter and the result list move between hits, and the
 * hit line is scrolled to and marked.
 */
const DB = resolve("tests/fixtures/db/seforim-v7-mini.db");
const SHOTS = process.env.SHOTS_DIR;

async function openBereshit(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(DB) }]);
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: /^בראשית/ }).first().getByRole("button", { name: "יעד" }).click();
  const target = page.locator(".reader.target");
  await expect(target.locator(".ln").nth(2)).toContainText("(א)", { timeout: 30_000 });
  return target;
}

test("search in a book: Ctrl+F, next/previous, result list, jump and highlight, Escape", async ({ page }) => {
  const seen = watchPage(page);
  const target = await openBereshit(page);

  // Ctrl+F while the reader has focus opens ITS search box
  await target.locator('.ln[data-i="3"] .tx').click();
  await page.keyboard.press("Control+f");
  const box = target.getByRole("searchbox", { name: "חיפוש בטקסט הספר" });
  await expect(box).toBeFocused();

  // typed without nikud, found in the pointed and cantillated text
  await box.fill("ויאמר אלהים");
  const count = target.locator(".find-count");
  await expect(count).toHaveText(/^1 מתוך \d+$/);
  const total = Number((await count.textContent())!.match(/מתוך (\d+)/)![1]);
  expect(total).toBeGreaterThan(3);
  const current = target.locator(".ln.find-current");
  await expect(current).toHaveCount(1);
  await expect(current).toBeInViewport();
  const first = Number(await current.getAttribute("data-i"));
  await expect(target.locator(".ln.find-hit")).toHaveCount(total);

  // Enter → next, Shift+Enter → previous
  await box.press("Enter");
  await expect(count).toHaveText(`2 מתוך ${total}`);
  const second = Number(await current.getAttribute("data-i"));
  expect(second).toBeGreaterThan(first);
  await box.press("Shift+Enter");
  await expect(count).toHaveText(`1 מתוך ${total}`);
  await target.getByRole("button", { name: "התוצאה הקודמת" }).click(); // wraps to the last
  await expect(count).toHaveText(`${total} מתוך ${total}`);

  // the result list: snippets with the match marked; clicking one jumps to its line
  await target.getByRole("button", { name: "רשימת התוצאות" }).click();
  const rows = target.getByRole("list", { name: "תוצאות החיפוש" }).getByRole("button");
  await expect(rows).toHaveCount(total);
  const marked = (await rows.nth(2).locator("mark").textContent())!;
  expect(marked).not.toBe("ויאמר אלהים"); // the original, pointed text…
  expect(marked.replace(/[\u0591-\u05c7]/g, "")).toBe("ויאמר אלהים"); // …of exactly the words searched
  await rows.nth(2).click();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/search-list.png` });
  await expect(count).toHaveText(`3 מתוך ${total}`);
  const third = Number(await current.getAttribute("data-i"));
  await expect(rows.nth(2).locator(".no")).toHaveText(String(third + 1));
  await expect(current).toBeInViewport();

  // nothing found / too short
  await box.fill("משה רבנו");
  await expect(count).toHaveText("אין תוצאות");
  await expect(target.locator(".ln.find-hit")).toHaveCount(0);
  await box.fill("א");
  await expect(count).toHaveText("לפחות שתי אותיות");

  // Escape closes the box and gives the focus back to the lines
  await box.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(target.locator(".panel-body")).toBeFocused();

  // the magnifier in the reader's head opens it too; the other reader has its own box
  await target.getByRole("button", { name: "חיפוש בטקסט הספר" }).click();
  await expect(target.getByRole("searchbox")).toBeFocused();
  await expect(page.locator(".reader.source").getByRole("searchbox")).toHaveCount(0);

  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
