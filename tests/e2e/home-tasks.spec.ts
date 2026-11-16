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
