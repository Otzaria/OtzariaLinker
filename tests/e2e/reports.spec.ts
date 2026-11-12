import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * The two reports a user keeps (stages 11, 15, 16): the quality check as one offline HTML page, and
 * the line mapping between two editions of a book as CSV — both downloaded from the built file.
 */
const nl = String.fromCharCode(10);

async function openFiles(page: Page, files: { name: string; buffer: Buffer; mimeType?: string }[]) {
  const chooser = page.waitForEvent("filechooser");
  // home: the drop strip's "קבצים"; the workspace: "הוספת מקור" → "קבצים"
  const pickBtn = page.getByRole("button", { name: "קבצים", exact: true });
  if (!(await pickBtn.isVisible())) await page.getByRole("button", { name: "הוספת מקור" }).click();
  await pickBtn.click();
  await (await chooser).setFiles(files.map((f) => ({ mimeType: "text/plain", ...f })));
}

test("QA: the report is saved as one offline HTML page, grouped by severity, with a fix per issue", async ({ page, browser }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  // new links from a sheet: an untouched record of a library file is kept as it is, its errors are
  // warnings (validate.asExported), so the errors group comes from links the user brings
  const rec = (l1: number, l2: number) => `${l1},בראשית,בראשית.txt,${l2},reference`;
  await openFiles(page, [
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ספר שלי.txt", buffer: Buffer.from(["<h1>ספר שלי</h1>", "שורה ב", "שורה ג", "שורה ד"].join(nl)) },
    { name: "ספר שלי_links.csv", mimeType: "text/csv", buffer: Buffer.from(["line_index_1,heRef_2,path_2,line_index_2,Conection Type", rec(2, 3), rec(2, 3), rec(3, 1)].join(nl)) },
  ]);
  await page.getByRole("tab", { name: /בדיקה/ }).click({ timeout: 30_000 });
  await page.getByRole("button", { name: "בדיקת הקישורים" }).click();
  await expect(page.getByText("3 קישורים נבדקו")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "שמירת הדוח כ־HTML" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^בדיקת-קישורים-\d{4}-\d\d-\d\d\.html$/);
  const html = readFileSync((await file.path())!, "utf8");
  expect(html).toMatch(/^<!doctype html>/);
  expect(html).not.toMatch(/<script|https?:/i);

  // the page itself, as someone who receives it sees it
  const viewer = await browser.newPage();
  const viewerSeen = watchPage(viewer);
  await viewer.setContent(html);
  await expect(viewer.getByRole("heading", { name: "דוח בדיקת קישורים" })).toBeVisible();
  await expect(viewer.getByRole("heading", { name: /^שגיאות \(\d+\)$/ })).toBeVisible();
  await expect(viewer.getByRole("heading", { name: /^אזהרות \(\d+\)$/ })).toBeVisible();
  await expect(viewer.getByRole("heading", { name: "קישור לכותרת (1)" })).toBeVisible();
  await expect(viewer.getByRole("heading", { name: "כפולים (1)" })).toBeVisible();
  await expect(viewer.locator("code", { hasText: "export/heading-line" })).toBeVisible();
  await expect(viewer.locator(".fix").first()).toHaveText(/\S/);
  await viewer.close();
  expect(viewerSeen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("relink: the two editions line by line, and the line mapping saved as CSV", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const v1 = ["<h1>ספר</h1>", "שורה ראשונה של הספר", "שורה שנייה של הספר והיא ארוכה", "שורה שלישית שתימחק לגמרי", "שורה רביעית של הספר"];
  const v2 = ["<h1>ספר</h1>", "הקדמה חדשה לגמרי", "שורה ראשונה של הספר", "שורה שנייה של הספר והיא קצרה", "שורה רביעית של הספר"];
  const links = JSON.stringify([2, 3, 5].map((l) => ({ line_index_1: l, heRef_2: "בסיס", path_2: "בסיס.txt", line_index_2: 1, "Conection Type": "reference" })));
  await openFiles(page, [{ name: "ספר.txt", buffer: Buffer.from(v1.join(nl)) }, { name: "ספר_links.json", buffer: Buffer.from(links) }]);
  await expect(page.locator(".source-row").last()).toBeVisible({ timeout: 30_000 });
  await openFiles(page, [{ name: "ספר.txt", buffer: Buffer.from(v2.join(nl)) }]);
  await expect(page.locator(".source-row")).toHaveCount(2, { timeout: 30_000 });
  await page.getByRole("tab", { name: /קישורים/ }).click();
  await page.getByRole("button", { name: "מעבר למהדורה חדשה של ספר" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("המהדורה החדשה").selectOption({ index: 1 });
  await dlg.getByRole("button", { name: "השוואה" }).click();

  await dlg.getByRole("button", { name: "השוואת השורות" }).click();
  const table = dlg.getByRole("table", { name: "השוואת השורות" });
  await expect(table.locator("tr.k-changed")).toHaveCount(1);
  await expect(table.locator("tr.k-changed del")).toHaveText("ארוכה");
  await expect(table.locator("tr.k-changed ins")).toHaveText("קצרה");
  await expect(table.locator("tr.k-inserted")).toContainText("הקדמה חדשה לגמרי");
  await expect(table.locator("tr.k-deleted")).toContainText("שורה שלישית שתימחק לגמרי");
  await dlg.getByRole("button", { name: /כל השורות/ }).click();
  await expect(table.locator("tbody tr")).toHaveCount(6);

  const download = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "שמירת מיפוי השורות (CSV)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^מיפוי-שורות-\d{4}-\d\d-\d\d\.csv$/);
  const csv = readFileSync((await file.path())!, "utf8");
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const rows = csv.slice(1).trimEnd().split("\r\n").map((r) => r.split(",").map((c) => c.slice(1, -1)));
  expect(rows.map((r) => [r[0], r[1], r[4]])).toEqual([
    ["שורה במהדורה הישנה", "שורה במהדורה החדשה", "קוד"],
    ["1", "1", "same"],
    ["", "2", "inserted"],
    ["2", "3", "same"],
    ["3", "4", "changed"],
    ["4", "", "deleted"],
    ["5", "5", "same"],
  ]);
  expect(seen.errors).toEqual([]);
});
