import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * Links in someone else's layout: a JSON file with its own field names, counting lines from 0. The
 * mapping dialog guesses the fields, the user fixes the target, the preview shows library numbering,
 * and the links arrive through the ordinary import.
 */
test("links from a JSON file in another layout: guess, fix one field, preview, import", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const records = [
    { from: "פירוש על בראשית", source_line: 0, book: "בראשית", to_line: 2, type: "commentary" },
    { from: "פירוש על בראשית", source_line: 1, book: "בראשית", to_line: 3, type: "commentary" },
  ];
  const commentary = "<h1>פירוש על בראשית</h1>\nבראשית - פירוש ראשון\nויאמר - פירוש שני\n";
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "פירוש על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(commentary) },
    { name: "export.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(records)) },
  ]);

  const dlg = page.getByRole("dialog", { name: /ייבוא קישורים: export.json/ });
  await expect(dlg).toBeVisible({ timeout: 30_000 });
  await expect(dlg).toContainText("2 רשומות");
  // "book" is not a known name for the target: the dialog says what is missing
  await expect(dlg.getByRole("status")).toContainText("ספר היעד");
  await expect(dlg.getByRole("button", { name: /ייבוא 2 רשומות/ })).toBeDisabled();
  await dlg.getByLabel("ספר היעד (שם)").selectOption("book");
  await dlg.getByLabel(/^ספר המקור/).selectOption({ label: "השדה from" });

  // 0-based in the file → 1-based in the preview
  const rows = dlg.getByRole("table", { name: "תצוגה מקדימה" }).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("פירוש על בראשית");
  await expect(rows.first().locator("td").nth(1)).toHaveText("1");
  await expect(rows.first().locator("td").nth(3)).toHaveText("3");

  await dlg.getByRole("button", { name: /ייבוא 2 רשומות/ }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole("tab", { name: /קישורים/ })).toContainText("2");
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
