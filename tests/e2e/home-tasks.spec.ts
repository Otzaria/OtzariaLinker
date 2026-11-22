import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { chooseTask, distUrl, watchPage } from "./helpers";

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
  await chooseTask(page, "repo", "db-links");
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
  await chooseTask(page, "repo", "db-links");
  let sheet = page.getByRole("dialog", { name: "הקישורים שכבר במסד" });
  let chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "המסד: מסד נתונים" }).click();
  await (await chooser).setFiles(DB_FILE);
  await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/, { timeout: 30_000 });
  await sheet.getByRole("button", { name: "התחלה" }).click();
  await expect(page.getByRole("tab", { name: /קישורים מהמסד/ })).toHaveAttribute("aria-selected", "true");

  // back home: another task that needs a database starts from the open one, no file chooser
  await page.getByRole("button", { name: /מנהל הקישורים — למסך הפתיחה/ }).click();
  await chooseTask(page, "repo", "within-db");
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
  await expect(page.getByText(/כבר פתוח, ולכן לא נטען שוב/)).toBeVisible();
  await expect(sheet.locator(".steps .opened")).toHaveCount(1);
  await start.click();
  await expect(page.getByRole("region", { name: "מקורות וספרים" }).locator(".src-badge")).toHaveCount(1);
  expect(seen.errors).toEqual([]);
});

/*
 * Issue 20: the home screen has five paths instead of ten cards; the choice between a commentary, footnotes, citations,
 * several books or a folder against Otzaria is made inside the wizard; every old address still opens its task.
 */
test("home: five paths; the choice is inside the wizard; old #/start/<id> addresses still work", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const cards = page.locator(".task-card");
  await expect(cards).toHaveCount(5);
  await expect(cards.locator("b")).toHaveText(["קישור אוטומטי", "קישור ידני", "ניתוח והשלמת קישורים במאגר", "בדיקה, תיקון ומיזוג קישורים", "פתיחת פרויקט קיים"]);

  // a path asks which task: a radio group the arrows move through
  await cards.filter({ hasText: "קישור אוטומטי" }).click();
  const dlg = page.getByRole("dialog", { name: "קישור אוטומטי" });
  const radios = dlg.getByRole("radio");
  await expect(radios).toHaveCount(5);
  await expect(radios.first()).toBeChecked();
  await radios.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(dlg.locator('[data-task="notes"]')).toBeChecked();
  await dlg.getByRole("button", { name: "המשך" }).click();
  // the task's own sheet, at the address the old card used, with a way back to the choice
  const sheet = page.getByRole("dialog", { name: "ספר והערות שוליים" });
  await expect(sheet).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#/start/notes");
  await sheet.getByRole("button", { name: "חזרה" }).click();
  await expect(page.getByRole("dialog", { name: "קישור אוטומטי" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("#/start/auto");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // the old addresses of the merged cards open their tasks, and the new paths are addresses too
  for (const [id, title] of [["commentary", "ספר ופירוש"], ["notes", "ספר והערות שוליים"], ["citations", "מראי מקומות"], ["db-db", "מסד מול מסד"], ["relink", "תיקון קישורים אחרי שינוי ספר"], ["fix", "בדיקה, תיקון ומיזוג קישורים"]] as const) {
    await page.goto(`${distUrl}#/start/${id}`);
    await expect(page.getByRole("dialog", { name: title })).toBeVisible();
  }
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("home: 'open an existing project' picks the project file, 'manual' opens its sheet", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".task-card", { hasText: "פתיחת פרויקט קיים" }).click();
  expect((await chooser).isMultiple()).toBeDefined();
  await page.locator(".task-card", { hasText: "קישור ידני" }).click();
  await expect(page.getByRole("dialog", { name: "קישור ידני" })).toBeVisible();
  expect(seen.errors).toEqual([]);
});

test("home: 'coverage of a book' (repository path) opens the check tab with the coverage section", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  await chooseTask(page, "repo", "coverage");
  const sheet = page.getByRole("dialog", { name: "כיסוי קישורים של ספר" });
  const chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "הספר והקישורים שלו: קבצים" }).click();
  await (await chooser).setFiles([txt("ספר שלי.txt", ["<h1>ספר שלי</h1>", "שורה שנייה", "שורה שלישית"])]);
  await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/, { timeout: 30_000 });
  await sheet.getByRole("button", { name: "התחלה" }).click();
  await expect(page.getByRole("tab", { name: /בדיקה/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("details.coverage")).toBeVisible();
  expect(seen.errors).toEqual([]);
});
