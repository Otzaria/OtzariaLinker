import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * Several sources at once (the owner's question: "I loaded a folder; now I want another folder, or
 * the Otzaria database, and to link between them — how?"): a folder, the real database slice and a
 * second folder are opened one after the other from the workspace's "הוספת מקור"; the books are
 * listed by source; a link is made from a folder book to a database book; max-link runs across all
 * three (folder → database, folder → folder); the export writes the folder books' links files.
 */
const nl = String.fromCharCode(10);
const HEB = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
const DB = { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) };

/** Writes a folder of text books under the test's output directory and returns its path. */
function folder(name: string, books: Record<string, string[]>): string {
  const dir = join(test.info().outputPath(), name);
  mkdirSync(dir, { recursive: true });
  for (const [title, lines] of Object.entries(books)) writeFileSync(join(dir, `${title}.txt`), lines.join(nl), "utf8");
  return dir;
}

/** In the workspace: "הוספת מקור" → one of its options → the picker. */
async function addSource(page: Page, option: "תיקייה" | "מסד נתונים" | "קבצים", files: string | (typeof DB)[]) {
  const item = page.getByRole("group", { name: "סוג המקור להוספה" }).getByRole("button", { name: option, exact: true });
  if (!(await item.isVisible())) await page.getByRole("button", { name: "הוספת מקור" }).click();
  const chooser = page.waitForEvent("filechooser");
  await item.click();
  await (await chooser).setFiles(files);
}

test("a folder, the Otzaria database and a second folder: grouped books, a link across sources, max-link across them, export", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const commentaries = folder("פירושים", {
    "ביאור על בראשית": ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])],
    "ספר דוגמה": ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה עם הערה (1) ועוד אחת (2).", "<h2>פרק ב</h2>", "כאן המספור מתחיל שוב (1)."],
  });
  const notes = folder("הערות", {
    "הערות לספר דוגמה": ["<h1>הערות לספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה בפרק א.", "(2) הערה שנייה בפרק א.", "<h2>פרק ב</h2>", "(1) הערה ראשונה בפרק ב."],
  });
  await page.goto(distUrl);

  // 1. the first folder, from the home screen
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "תיקייה", exact: true }).click();
  await (await chooser).setFiles(commentaries);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 30_000 });
  await expect(page).toHaveURL(/#\/workspace\/builder$/);

  // 2. the Otzaria database and 3. a second folder, added from the workspace
  await addSource(page, "מסד נתונים", [DB]);
  await expect(page.locator(".source-row")).toHaveCount(2, { timeout: 30_000 });
  await addSource(page, "תיקייה", notes);
  const rows = page.locator(".source-row");
  await expect(rows).toHaveCount(3, { timeout: 30_000 });
  await expect(rows.nth(0)).toContainText("פירושים");
  await expect(rows.nth(0).locator(".src-badge")).toHaveText("תיקייה");
  await expect(rows.nth(1).locator(".src-badge")).toHaveText("מסד אוצריא");
  await expect(rows.nth(2).locator(".src-badge")).toHaveText("תיקייה");

  // the books, grouped by source — the database last
  const groups = page.locator(".book-group");
  await expect(groups).toHaveCount(3);
  await expect(groups.last().locator(".group-head")).toContainText("seforim.db");
  await expect(groups.first().locator(".book-list li")).toHaveCount(2);

  // a link from a folder book to a database book
  const books = page.locator(".book-list li");
  await books.filter({ hasText: "ביאור על בראשית" }).first().getByRole("button", { name: "מקור" }).click();
  await books.filter({ hasText: /^בראשית/ }).first().getByRole("button", { name: "יעד" }).click();
  await expect(page.locator(".reader.source .panel-head .src-badge")).toHaveText("תיקייה");
  await expect(page.locator(".reader.target .panel-head .src-badge")).toHaveText("מסד אוצריא");
  await page.getByRole("tab", { name: "בונה" }).click();
  await page.locator('.reader.source .ln[data-i="3"] .tx').click();
  await page.locator('.reader.target .ln[data-i="2"] .tx').click();
  await page.locator(".builder").getByPlaceholder("Genesis 1:1").fill("Genesis 1:1");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator('.reader.source .ln[data-i="3"] .mark.new')).toHaveText("1");

  // max-link over everything open: the commentary against the database, the notes book against the other folder
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("radio", { name: "קישור מרבי" }).click();
  await expect(page).toHaveURL(/#\/maxlink$/);
  await page.getByRole("radio", { name: "כל הספרים הפתוחים" }).click();
  await page.locator("summary", { hasText: "למה כל ספר" }).click();
  const why = page.locator(".ml-books");
  await expect(why.locator("li").filter({ has: page.locator("b", { hasText: "ביאור על בראשית" }) })).toContainText("בראשית");
  await expect(why.locator("li").filter({ has: page.locator("b", { hasText: "הערות לספר דוגמה" }) })).toContainText("ספר הערות על");
  await page.getByRole("button", { name: "הפעלת קישור מרבי" }).click();
  await expect(page.locator("details.ml-report")).toBeVisible({ timeout: 60_000 });
  const approve = page.getByRole("button", { name: /אישור כל הוודאיות/ });
  await expect(approve).toBeEnabled();
  await approve.click();
  const table = page.getByRole("table", { name: "הצעות" });
  // suggestions came from both pairs: the commentary on the database book and the notes of the other folder
  await page.getByRole("button", { name: "הכול", exact: true }).click();
  await expect(table).toContainText("ביאור על בראשית");
  await expect(table).toContainText("ספר דוגמה");

  // the export: one links file per folder book with links
  await page.getByRole("button", { name: /^ייצוא( \(\d+\))?$/ }).click();
  await expect(page).toHaveURL(/#\/export$/);
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".files")).toContainText("ביאור על בראשית_links.json", { timeout: 30_000 });
  await expect(dialog.locator(".files")).toContainText("ספר דוגמה_links.json");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: /^הורדת (ZIP|הקובץ)$/ }).click();
  expect((await download).suggestedFilename()).toMatch(/\.(zip|json)$/);
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/#\/maxlink$/); // closing the dialog went back to the screen under it

  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
