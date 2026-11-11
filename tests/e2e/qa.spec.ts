import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

test("QA finds a duplicate and a link to a heading line; the bulk fix removes only the copy", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const rec = (l1: number, l2: number) => ({ line_index_1: l1, heRef_2: "בראשית", path_2: "בראשית.txt", line_index_2: l2, "Conection Type": "reference" });
  const links = JSON.stringify([rec(2, 3), rec(2, 3), rec(3, 1)], null, 2); // a duplicate; line 1 of בראשית is <h1>
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ספר שלי.txt", mimeType: "text/plain", buffer: Buffer.from("<h1>ספר שלי</h1>\nשורה ב\nשורה ג\nשורה ד") },
    { name: "ספר שלי_links.json", mimeType: "application/json", buffer: Buffer.from(links) },
  ]);
  await page.getByRole("tab", { name: /בדיקה/ }).click({ timeout: 30_000 });
  await page.getByRole("button", { name: "בדיקת הקישורים" }).click();
  await expect(page.getByText("3 קישורים נבדקו")).toBeVisible();
  await expect(page.getByRole("button", { name: "כפולים 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "קישור לכותרת 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /מחיקת 1 העתקים כפולים/ }).click();
  await expect(page.getByText("2 קישורים נבדקו")).toBeVisible();
  await expect(page.getByRole("button", { name: /^כפולים/ })).toHaveCount(0);
  expect(seen.errors).toEqual([]);
});
