import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * The two guided tasks the product audit found missing (F15): "several books together" runs max-link
 * over every open book, and "links already in the database" opens the links tab on the database's
 * own links. Both run the existing flows — no new engine.
 */
const nl = String.fromCharCode(10);
const txt = (name: string, lines: string[]) => ({ name, mimeType: "text/plain", buffer: Buffer.from(lines.join(nl), "utf8") });
const DB = { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) };

test("'several books together' plans max-link over all the open books", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // the card starts the guided flow now (guided-flow.spec.ts); the task's sheet is still its route
  await page.goto(`${distUrl}#/start/several`);
  const sheet = page.getByRole("dialog", { name: "כמה ספרים יחד" });
  await expect(sheet).toBeVisible();
  const chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "הספרים: קבצים" }).click();
  await (await chooser).setFiles([
    txt("ספר דוגמה.txt", ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה עם הערה (1) ועוד אחת (2)."]),
    txt("הערות על ספר דוגמה.txt", ["<h1>הערות על ספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה", "(2) הערה שנייה"]),
    txt("ביאור על ספר דוגמה.txt", ["<h1>ביאור על ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה - ביאור"]),
  ]);
  await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/, { timeout: 30_000 });
  await sheet.getByRole("button", { name: "התחלה" }).click();

  await expect(page.getByRole("radio", { name: "כל הספרים הפתוחים" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".ml-plan-line")).toContainText("3 ספרים נבחרו");
  expect(seen.errors).toEqual([]);
});

test("'links already in the database' opens the database's links of the book in the reader", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  await page.locator(".task-card", { hasText: "הקישורים שכבר במסד" }).click();
  const sheet = page.getByRole("dialog", { name: "הקישורים שכבר במסד" });
  const chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "המסד: מסד נתונים" }).click();
  await (await chooser).setFiles([DB]);
  await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/, { timeout: 30_000 });
  await sheet.getByRole("button", { name: "התחלה" }).click();

  await expect(page.getByRole("tab", { name: /קישורים מהמסד/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".dbl .dbl-sum")).toContainText("קישורים במסד", { timeout: 30_000 });
  expect(seen.errors).toEqual([]);
});

/*
 * #22: a database picked once is one source. Going home and opening another task offers the open source
 * instead of asking for the file again, and picking the same file again does not load it twice.
 */
test("an open database is offered by the next task sheet, and picking it again does not add a second source", async ({ page }) => {
  // a real file on disk: its last-modified time is stable, as for a file the user picks twice (a buffer gets a new one each time)
  const DB_FILE = resolve("tests/fixtures/db/seforim-v7-mini.db");
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  await page.locator(".task-card", { hasText: "הקישורים שכבר במסד" }).click();
  let sheet = page.getByRole("dialog", { name: "הקישורים שכבר במסד" });
  let chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "המסד: מסד נתונים" }).click();
  await (await chooser).setFiles(DB_FILE);
  await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/, { timeout: 30_000 });
  await sheet.getByRole("button", { name: "התחלה" }).click();
  await expect(page.getByRole("tab", { name: /קישורים מהמסד/ })).toHaveAttribute("aria-selected", "true");

  // back home: another task that needs a database starts from the open one, no file chooser
  await page.getByRole("button", { name: /מנהל הקישורים — למסך הפתיחה/ }).click();
  await page.locator(".task-card", { hasText: "קישור בתוך מסד אישי" }).click();
  sheet = page.getByRole("dialog", { name: "קישור בתוך מסד אישי" });
  const start = sheet.getByRole("button", { name: "התחלה" });
  await expect(start).toBeDisabled();
  await sheet.getByRole("button", { name: "המשך עם המקורות הפתוחים" }).click();
  await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/);
  await expect(start).toBeEnabled();

  // the same file picked again: still one source, and the notice says it was not loaded twice
  chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "המסד האישי: מסד נתונים" }).click();
  await (await chooser).setFiles(DB_FILE);
  await expect(page.getByText(/כבר פתוח: הוא לא נטען שוב/)).toBeVisible();
  await expect(sheet.locator(".steps .opened")).toHaveCount(1);
  await start.click();
  await expect(page.getByRole("region", { name: "מקורות וספרים" }).locator(".src-badge")).toHaveCount(1);
  expect(seen.errors).toEqual([]);
});
