import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * Reviewing suggestions (V7 §3.11, findings #41 B22): a commentary written verse by verse against the real Bereshit slice,
 * run by headings in the worker of the built file.
 */
const HEB = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "יא", "יב", "יג", "יד", "טו", "טז", "יז", "יח", "יט", "כ"];

async function headingsRun(page: Page, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto(distUrl);
  const biur = ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])].join("\n");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ביאור על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(biur) },
  ]);
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: "ביאור על בראשית" }).locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await expect(page.getByRole("button", { name: /אישור כל הוודאיות/ })).toBeEnabled({ timeout: 30_000 });
  return page.getByRole("table", { name: "הצעות" });
}

test("a second press of 'אישור' takes the approval back to pending, not to rejected (#41 B22)", async ({ page }) => {
  const seen = watchPage(page);
  const table = await headingsRun(page);
  await page.locator(".filters .chip", { hasText: "הכול" }).click();
  const approve = table.getByRole("button", { name: "אישור ההצעה לשורה 4", exact: true });
  await approve.click();
  await expect(approve).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("tab", { name: /קישורים/ })).toContainText("1");
  await approve.click();
  await expect(approve).toHaveAttribute("aria-pressed", "false");
  await expect(table.getByRole("button", { name: "דחיית ההצעה לשורה 4", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".filters .chip", { hasText: "נדחתה" })).toHaveCount(0);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
