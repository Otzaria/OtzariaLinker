import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

const SHOTS = process.env.SHOTS_DIR;

test("headings engine: run in the worker → table → approve all certain → card view → undo", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const heb = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י", "יא", "יב", "יג", "יד", "טו", "טז", "יז", "יח", "יט", "כ"];
  // a commentary the database has no links for (Onkelos is already linked there: it would show as "exists")
  const biur = ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...heb.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])].join(String.fromCharCode(10));
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ביאור על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(biur) },
  ]);

  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: "ביאור על בראשית" }).getByRole("button", { name: "מקור" }).click();
  await books.filter({ hasText: /^בראשית/ }).first().getByRole("button", { name: "יעד" }).click();

  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  const approveAll = page.getByRole("button", { name: /אישור כל הוודאיות/ });
  await expect(approveAll).toBeEnabled({ timeout: 30_000 });
  const n = Number((await approveAll.textContent())!.match(/\(([\d,]+)\)/)![1]!.replace(/,/g, ""));
  expect(n).toBe(20);
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
