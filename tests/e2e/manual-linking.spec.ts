import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * The main manual flow in the real single file, offline from file://:
 * open a database + a commentary file → choose books → pick lines → create → undo/redo → export.
 */
const DB = resolve("tests/fixtures/db/seforim-v7-mini.db");
const COMMENTARY = { name: "פירוש על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from("<h1>פירוש על בראשית</h1>\nבראשית - פירוש ראשון\nויאמר - פירוש שני\n", "utf8") };
const SHOTS = process.env.SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function openFiles(page: Page) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(DB) }, COMMENTARY]);
}

test("open → pick → create → undo/redo → export, offline", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  await expect(page.getByRole("heading", { name: "מה תרצו לעשות?" })).toBeVisible();
  await shot(page, "1-home");

  await openFiles(page);
  await expect(page.locator(".source-row")).toHaveCount(2, { timeout: 30_000 }); // opening a DB under CI load can be slow

  // source = the commentary, target = Bereshit
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: "פירוש על בראשית" }).getByRole("button", { name: "מקור" }).click();
  await books.filter({ hasText: /^בראשית/ }).first().getByRole("button", { name: "יעד" }).click();
  const source = page.locator(".reader.source");
  const target = page.locator(".reader.target");
  await expect(source.locator(".ln").nth(1)).toContainText("פירוש ראשון");
  await expect(target.locator(".ln").nth(2)).toContainText("(א)");
  await shot(page, "2-workspace");

  await source.locator('.ln[data-i="1"] .tx').click();
  await target.locator('.ln[data-i="2"] .tx').click();
  const builder = page.locator(".builder");
  // Bereshit is a Sefaria book: the library's weekly sync wants the English ref, and the builder builds
  // it from the line's heRef (compatibility review B1) — shown as the field's placeholder, no warning
  await expect(builder.getByPlaceholder("Genesis 1:1")).toHaveAttribute("title", /אוטומטית/);
  await expect(builder.locator(".problems", { hasText: "ref_2" })).toHaveCount(0);
  await expect(builder.getByRole("button", { name: "יצירת קישור" })).toBeEnabled();
  await builder.getByPlaceholder("Genesis 1:1").fill("Genesis 1:1");
  await expect(builder.getByRole("button", { name: "יצירת קישור" })).toBeEnabled();
  await expect(builder.locator(".stored-as")).toContainText("בראשית"); // shows how Otzaria will store it
  await shot(page, "3-builder");
  await page.keyboard.press("Control+Enter");

  await expect(source.locator('.ln[data-i="1"] .mark.new')).toHaveText("1");
  await expect(target.locator('.ln[data-i="2"] .mark.new')).toHaveText("1");
  await expect(source.locator('.ln[data-i="2"]')).toHaveClass(/picked/); // the source advances to the next line

  await page.getByRole("button", { name: "ביטול" }).first().click();
  await expect(source.locator('.ln[data-i="1"] .mark.new')).toHaveCount(0);
  await page.keyboard.press("Control+y");
  await expect(source.locator('.ln[data-i="1"] .mark.new')).toHaveText("1");

  await page.getByRole("tab", { name: /קישורים/ }).click();
  await expect(page.locator(".link-item")).toHaveCount(1);
  await shot(page, "4-links");

  await page.getByRole("button", { name: /ייצוא/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("פירוש על בראשית_links.json");
  await shot(page, "5-export");
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "הורדת הקובץ" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("פירוש על בראשית_links.json");
  const records = JSON.parse(readFileSync(await file.path(), "utf8")) as Record<string, unknown>[];
  expect(records).toEqual([{ line_index_1: 2, heRef_2: "בראשית, א, א", path_2: "בראשית.txt", line_index_2: 3, ref_2: "Genesis 1:1", "Conection Type": "source" }]);

  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("dark theme and narrow screen keep the workspace usable", async ({ page }) => {
  const seen = watchPage(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(distUrl);
  await openFiles(page);
  await page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li").filter({ hasText: /^בראשית/ }).first().getByRole("button", { name: "מקור" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await shot(page, "6-dark");
  await page.setViewportSize({ width: 600, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, "7-narrow");
  expect(seen.errors).toEqual([]);
});
