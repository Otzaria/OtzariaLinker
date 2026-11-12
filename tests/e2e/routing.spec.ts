import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * The address follows the screens and dialogs (state/router.ts): a guided workflow's sheet, the
 * workspace's tabs, max-link, help and export each have a route; Back and Forward move between
 * them, Back closes a dialog, Esc goes back the same way; a reload, which loses the open files,
 * lands on the home screen with a short note.
 */
const nl = String.fromCharCode(10);
const DB = { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) };
const hash = (page: Page) => decodeURIComponent(new URL(page.url()).hash);

test("routes: a guided workflow, tabs, max-link, help and export; Back/Forward/Esc; reload falls back home", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const dir = join(test.info().outputPath(), "פירושים");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ביאור על בראשית.txt"), ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", "<h3>פסוק א</h3>", "ביאור לפסוק 1"].join(nl), "utf8");
  await page.goto(distUrl);

  // the workflow "a folder against Otzaria": its sheet asks for the folder, then the database
  await page.getByRole("button", { name: /תיקייה מול אוצריא/ }).click();
  const sheet = page.getByRole("dialog", { name: "תיקייה מול אוצריא" });
  await expect(sheet).toBeVisible();
  expect(hash(page)).toBe("#/start/folder-otzaria");
  const start = sheet.getByRole("button", { name: "התחלה" });
  await expect(start).toBeDisabled();
  let chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "התיקייה: תיקייה" }).click();
  await (await chooser).setFiles(dir);
  await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/, { timeout: 30_000 });
  await expect(start).toBeDisabled(); // the database is still missing
  await expect(sheet).toContainText("C:\\ProgramData\\otzaria\\books\\seforim.db");
  chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "מסד אוצריא: מסד נתונים" }).click();
  await (await chooser).setFiles([DB]);
  await expect(sheet.locator(".steps > li").nth(1)).toHaveClass(/done/, { timeout: 30_000 });
  await start.click();

  // it starts max-link on the folder
  await expect(sheet).toBeHidden();
  await expect.poll(() => hash(page)).toBe("#/maxlink");
  await expect(page.getByRole("radio", { name: "מקור או תיקייה" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("label.field select").first()).toHaveValue(/.+/);
  await expect(page.locator("label.field select").first().locator("option:checked")).toContainText("פירושים");

  // tabs are entries; Back and Forward walk them
  await page.getByRole("tab", { name: /^קישורים \d/ }).click();
  await expect.poll(() => hash(page)).toBe("#/workspace/links");
  await page.getByRole("tab", { name: /בדיקה/ }).click();
  await expect.poll(() => hash(page)).toBe("#/workspace/qa");
  await page.goBack();
  await expect(page.getByRole("tab", { name: /^קישורים \d/ })).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect(page.getByRole("radio", { name: "קישור מרבי" })).toHaveAttribute("aria-checked", "true");
  await page.goForward();
  await expect(page.getByRole("tab", { name: /^קישורים \d/ })).toHaveAttribute("aria-selected", "true");

  // help: F1 opens it as a route; Back closes it and the tab is still there
  await page.keyboard.press("F1");
  const help = page.getByRole("dialog", { name: /עזרה/ });
  await expect(help).toBeVisible();
  await expect.poll(() => hash(page)).toMatch(/^#\/help/);
  await page.goBack();
  await expect(help).toBeHidden();
  await expect.poll(() => hash(page)).toBe("#/workspace/links");
  // Forward reopens it; Esc goes back again
  await page.goForward();
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expect.poll(() => hash(page)).toBe("#/workspace/links");

  // a dialog of the links tab: its close button goes back
  await page.getByRole("button", { name: /^מבני כותרות/ }).click();
  const exp = page.getByRole("dialog");
  await expect(exp).toBeVisible();
  await expect.poll(() => hash(page)).toBe("#/alt-toc");
  await exp.getByRole("button", { name: "ביטול" }).click();
  await expect(exp).toBeHidden();
  await expect.poll(() => hash(page)).toBe("#/workspace/links");

  // home and back to the workspace
  await page.getByRole("button", { name: /מנהל הקישורים/ }).click();
  await expect.poll(() => hash(page)).toBe("#/");
  await page.goBack();
  await expect(page.getByRole("tab", { name: /^קישורים \d/ })).toHaveAttribute("aria-selected", "true");

  // a reload loses the open files: home, with a note, and no error
  await page.reload();
  await expect(page.getByRole("heading", { name: "מה תרצו לעשות?" })).toBeVisible();
  await expect(page.locator(".notices")).toContainText("התחלנו במסך הפתיחה");
  await expect.poll(() => hash(page)).toBe("#/");

  // a deep link to a help section works without sources
  await page.goto(`${distUrl}#/help/13-קיצורי-מקלדת`);
  await page.reload();
  await expect(help).toBeVisible();
  await expect(help.locator('h2[id^="13-"]')).toBeInViewport();

  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
