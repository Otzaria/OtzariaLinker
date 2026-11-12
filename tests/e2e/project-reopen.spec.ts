import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * A saved project opened in a fresh browser (audit F10): the browser cannot reopen its files, so the
 * workspace lists the sources the project was saved with — by name, with the books its links wait
 * for — and a button per source opens the matching picker. The list stays until they are open.
 */
const DB = { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) };
const PROJECT = {
  name: "עבודה.otzlinker.json",
  mimeType: "application/json",
  buffer: Buffer.from(
    JSON.stringify({
      format: "otzaria-linker-project",
      version: 1,
      savedAt: "2026-11-01T10:00:00.000Z",
      app: "4.0.0",
      sources: [
        { label: "seforim.db", kind: "otzaria-db", books: 9, titles: ["בראשית"] },
        { label: "ביאור על בראשית.txt", kind: "text-files", books: 1, files: ["ביאור על בראשית.txt"], titles: ["ביאור על בראשית"] },
      ],
      links: [],
      rejectedSuggestions: [],
      view: { source: "ביאור על בראשית", target: "בראשית" },
    }),
  ),
};

test("a reopened project lists its sources by name and each one's button opens it again", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".drop-strip").getByRole("button", { name: "פרויקט שמור" }).click();
  await (await chooser).setFiles(PROJECT);

  const list = page.getByRole("region", { name: "מקורות לפתוח מחדש" });
  await expect(list).toBeVisible();
  await expect(list).toContainText("seforim.db");
  await expect(list).toContainText("ביאור על בראשית.txt");
  await expect(list).toContainText("בראשית");
  // it does not fade like a notice
  await page.waitForTimeout(5500);
  await expect(list).toBeVisible();

  const db = page.waitForEvent("filechooser");
  await list.getByRole("button", { name: "פתיחה מחדש: seforim.db" }).click();
  await (await db).setFiles(DB);
  // the database is back; the text file is still missing, now listed in the sources panel
  const panel = page.locator(".sources-panel").getByRole("region", { name: "מקורות לפתוח מחדש" });
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText("seforim.db");
  await expect(panel).toContainText("ביאור על בראשית.txt");

  await panel.getByRole("button", { name: "הסתרת רשימת המקורות לפתוח מחדש" }).click();
  await expect(page.getByRole("region", { name: "מקורות לפתוח מחדש" })).toHaveCount(0);
  expect(seen.errors).toEqual([]);
});
