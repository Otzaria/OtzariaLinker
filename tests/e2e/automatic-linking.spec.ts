import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;

test("headings engine: run in the worker → table → approve all certain → card view → undo", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "מסד נתונים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) }]);

  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: "תרגום אונקלוס על בראשית" }).getByRole("button", { name: "מקור" }).click();
  await books.filter({ hasText: /^בראשית/ }).first().getByRole("button", { name: "יעד" }).click();

  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  const approveAll = page.getByRole("button", { name: /אישור כל הוודאיות/ });
  await expect(approveAll).toBeEnabled({ timeout: 30_000 });
  const n = Number((await approveAll.textContent())!.match(/\(([\d,]+)\)/)![1]!.replace(/,/g, ""));
  expect(n).toBeGreaterThan(50);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/8-suggestions-table.png` });

  await approveAll.click();
  await expect(approveAll).toBeDisabled();
  await expect(page.getByRole("tab", { name: /קישורים/ })).toContainText(n.toLocaleString("en"));

  await page.getByRole("radio", { name: "כרטיס" }).click();
  await expect(page.getByRole("button", { name: /אישור/ }).first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/9-suggestions-card.png` });

  await page.keyboard.press("Control+z");
  await page.getByRole("radio", { name: "טבלה" }).click();
  await expect(page.getByRole("button", { name: /אישור כל הוודאיות/ })).toBeEnabled();
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
