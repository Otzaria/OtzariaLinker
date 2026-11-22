import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { chooseTask, distUrl, watchPage } from "./helpers";

/*
 * V6 3.9: the repository analysis — an open database as a whole, from the "analyze and complete links in a repository" path.
 * Nothing is read until asked; the count goes book by book and can be stopped; the book list is searchable and sortable; one
 * book's details; pairs the tool suggests, chosen by the user; and "complete the links of the chosen" opens the guided flow with
 * exactly those books, running nothing.
 */
const DB_FILE = resolve("tests/fixtures/db/seforim-v7-mini.db");

test("repository: analyze a database, find the books without links, pick a suggested pair and carry it to the guided flow", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  await chooseTask(page, "repo", "analyze");
  const sheet = page.getByRole("dialog", { name: "ניתוח מאגר והשלמת קישורים" });
  const chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "המסד: מסד נתונים" }).click();
  await (await chooser).setFiles(DB_FILE);
  await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/, { timeout: 30_000 });
  await sheet.getByRole("button", { name: "התחלה" }).click();

  const dlg = page.locator("dialog.repository");
  await expect(dlg).toBeVisible();
  await expect(page).toHaveURL(/#\/repository$/);
  // nothing was read yet: the books are listed, their links are "not checked"
  const books = dlg.getByRole("list", { name: "הספרים" }).locator(".repo-book");
  await expect(books.first()).toContainText("לא נבדק");
  const stats = dlg.getByRole("group", { name: "סיכום המאגר" });
  await expect(stats).toContainText("ספרים בלי קישורים");
  await expect(stats.locator(".stat").nth(1).locator("b")).toHaveText("—");

  // the count: one book at a time, then the totals
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  await expect(stats.locator(".stat").nth(1).locator("b")).not.toHaveText("—");
  await expect(books.first()).not.toContainText("לא נבדק");
  await dlg.locator("details.repo-more summary").click();
  await expect(dlg.getByRole("list", { name: "קישורים לפי סוג" })).toBeVisible();

  // the list: search, and the books with no links
  await dlg.getByLabel("חיפוש ספר").fill("ארצות החיים");
  await expect(books.filter({ hasText: "ארצות החיים" })).not.toHaveCount(0);
  await expect(books.filter({ hasText: "6 קישורים" })).not.toHaveCount(0);
  await dlg.getByLabel("חיפוש ספר").fill("");
  await dlg.getByLabel("אילו ספרים להציג").selectOption("no-links");
  const noLinks = await books.count();
  const total = Number(((await stats.locator(".stat").nth(2).locator("b").innerText()) || "0").replace(/,/g, ""));
  expect(noLinks).toBe(total);
  if (noLinks) await expect(books.first()).toContainText("בלי קישורים");
  await dlg.getByLabel("אילו ספרים להציג").selectOption("all");
  await dlg.getByLabel("סדר הרשימה").selectOption("links-desc");
  await expect(books.first()).toContainText("קישורים");

  // one book's details: how it is linked, its coverage
  await dlg.getByLabel("חיפוש ספר").fill("ארצות החיים");
  await books.filter({ hasText: "6 קישורים" }).first().getByRole("button", { name: /^פרטי הספר/ }).click();
  const detail = dlg.getByRole("region", { name: /^פרטי הספר/ });
  await expect(detail).toContainText("6", { timeout: 30_000 });
  await expect(detail.getByRole("list", { name: "הספרים המקושרים" })).toBeVisible();
  await detail.getByRole("button", { name: /חישוב כיסוי מלא/ }).click();
  await expect(detail.getByRole("status").filter({ hasText: /שורות (ה)?תוכן/ })).toBeVisible({ timeout: 30_000 });
  await detail.getByRole("button", { name: "סגירת הפרטים" }).click();
  await dlg.getByLabel("חיפוש ספר").fill("");

  // suggested pairs: proposed, with the reasons; nothing is chosen for the user
  await expect(dlg.locator(".repo-chosen")).toContainText("עוד לא נבחרו");
  await dlg.getByRole("button", { name: "הצעת זוגות לפי השמות" }).click();
  const pair = dlg.getByRole("list", { name: "זוגות מוצעים" }).locator(".repo-pair", { hasText: "המאיר לארץ על ארצות החיים" });
  await dlg.getByLabel("גם ספרים שכבר מקושרים").check();
  await expect(pair).toBeVisible({ timeout: 30_000 });
  await expect(pair).toContainText(/ביטחון (גבוה|בינוני|נמוך)/);
  await expect(pair.locator(".repo-reasons li").first()).toBeVisible();
  await expect(dlg.getByRole("button", { name: "השלמת קישורים לנבחרים" })).toBeDisabled();
  await pair.getByRole("checkbox").check();
  await expect(dlg.locator(".repo-chosen")).toContainText("נבחרו 1 ספרים");

  // complete: the guided flow opens at the books it was given, and nothing ran
  await dlg.getByRole("button", { name: "השלמת קישורים לנבחרים" }).click();
  await expect(page).toHaveURL(/#\/guided\/books$/);
  const main = page.locator("main.guided");
  await expect(main).toContainText("המאיר לארץ על ארצות החיים", { timeout: 30_000 });
  await expect(main.getByRole("heading", { name: "הספרים שנמצאו" })).toBeVisible();
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("repository: the dialog fits a phone", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(distUrl);
  await chooseTask(page, "repo", "analyze");
  const sheet = page.getByRole("dialog", { name: "ניתוח מאגר והשלמת קישורים" });
  const chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "המסד: מסד נתונים" }).click();
  await (await chooser).setFiles(DB_FILE);
  await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/, { timeout: 30_000 });
  await sheet.getByRole("button", { name: "התחלה" }).click();
  const dlg = page.locator("dialog.repository");
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של/)).toBeVisible({ timeout: 60_000 });
  // nothing is cut off sideways: the body does not scroll horizontally and the page does not either
  expect(await dlg.locator(".body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(dlg.getByRole("button", { name: "השלמת קישורים לנבחרים" })).toBeVisible();
  expect(seen.errors).toEqual([]);
});
