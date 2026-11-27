import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * Managing existing links (V5 P1-9) on the built file, offline: compare a book's database links with
 * an edited version of its links file, save the report, merge two versions of the file into the
 * project after the preview, then a group action in the links table — each one undo step.
 * The data: tests/fixtures/db/seforim-v7-mini.db and the records of tests/integration/state/link-compare.test.ts
 * (the library's real record of link 13469515, and the book's other database rows as records).
 */
const MEIR = "המאיר לארץ על ארצות החיים";
const YEHUDA = "ארץ יהודה על ארצות החיים";
const LIB_1 = { line_index_1: 323, heRef_2: 'המאיר לארץ על ארצות החיים, סימן יא, סעיף ד ס"ק יח', path_2: `${MEIR}.txt`, line_index_2: 1307, start: 33, "Conection Type": "commentary" };
const rec = (s: number, title: string, t: number, end?: number) => ({ line_index_1: s, heRef_2: `${title} ${t}`, path_2: `${title}.txt`, line_index_2: t, ...(end && { line_index_2_end: end }), "Conection Type": "commentary" });
const DB_ROWS = [rec(333, YEHUDA, 314, 317), rec(397, YEHUDA, 450, 455), rec(425, MEIR, 1979), rec(613, YEHUDA, 672, 711), rec(613, MEIR, 2663)];
const V1 = JSON.stringify([LIB_1, ...DB_ROWS], null, 2);
const V2 = JSON.stringify([LIB_1, DB_ROWS[0], rec(397, YEHUDA, 450, 460), rec(425, MEIR, 1980), DB_ROWS[3], rec(500, MEIR, 2000)], null, 2);
const NAME = "ארצות החיים_links.json";

test("compare the database with a links file, merge two versions, a group action in the links table", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  let chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) }]);
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: /^ארצות החיים/ }).locator('button.side-btn[data-side="source"]').click({ timeout: 30_000 });

  await page.getByRole("tab", { name: /קישורים/ }).first().click();
  await page.getByRole("button", { name: "השוואה ומיזוג" }).click();
  const dlg = page.getByRole("dialog");
  for (const text of [V1, V2]) {
    chooser = page.waitForEvent("filechooser");
    await dlg.getByRole("button", { name: /הוספת קובצי/ }).click();
    await (await chooser).setFiles([{ name: NAME, mimeType: "application/json", buffer: Buffer.from(text) }]);
  }
  await expect(dlg.getByLabel("הספר")).toHaveValue("ארצות החיים");
  await dlg.getByRole("button", { name: "קריאת הקישורים מהמסד" }).click();
  await expect(dlg.locator(".cmp-sets").first()).toContainText("המסד 6 קישורים");

  await dlg.getByLabel("לפני (א)").selectOption({ label: "המסד" });
  await dlg.getByLabel("אחרי (ב)").selectOption({ label: `⁦${NAME} (2)⁩` });
  await dlg.getByRole("button", { name: "השוואה", exact: true }).click();
  const chips = dlg.locator(".cmp-diff .chip");
  await expect(chips).toHaveText([/^סותרים\s*1$/, /^טווחים חופפים\s*1$/, /^רק במסד\s*1$/, /^רק ב־⁦ארצות החיים_links.json \(2\)⁩\s*1$/, /^זהים\s*3$/]);
  await expect(dlg.locator(".cmp-table tbody tr").first()).toContainText("יעד שונה");
  await chips.filter({ hasText: "רק במסד" }).click();
  await expect(dlg.locator(".cmp-diff .cmp-table tbody tr")).toHaveText([/נמחק.*ארצות החיים 613 ← המאיר לארץ על ארצות החיים 2663/]);
  const download = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "שמירת דוח (CSV)" }).click();
  expect((await download).suggestedFilename()).toBe("השוואת קישורים - ארצות החיים.csv");

  // merge: the first version preferred; the preview first
  const merge = dlg.locator(".cmp-merge");
  await expect(merge.locator(".stat b")).toHaveText(["6", "1", "3", "2"]);
  await merge.getByRole("button", { name: "מיזוג לפרויקט" }).click();
  await expect(page.getByText(/המיזוג הוחל. נוספו: קישור אחד/)).toBeVisible();
  await dlg.getByRole("button", { name: "סגירה" }).click();

  const items = page.locator(".vlist .link-item");
  await expect(items).toHaveCount(7);
  await expect(page.locator(".vlist")).toContainText(`מ־${NAME} (2)`);
  // select all shown → change the type: one action, one undo
  await page.locator(".lt-head input[type=checkbox]").check();
  await page.getByRole("toolbar", { name: "פעולות על הנבחרים" }).getByLabel("שינוי סוג הקשר").selectOption("reference");
  await expect(items.filter({ hasText: "הפניה" })).toHaveCount(7);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // shortcuts do not fire inside a select
  await page.keyboard.press("Control+z");
  await expect(items.filter({ hasText: "הפניה" })).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(items).toHaveCount(0);

  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

/*
 * #15: two versions of a file that differ only in the place name (heRef_2) and a ref used to be listed as
 * "conflicts" whose two columns read the same. They are their own group now, and the cell names the field.
 */
test("two versions of a links file that differ only in the place name: not a conflict, and the difference is shown", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  let chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) }]);
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: /^ארצות החיים/ }).getByRole("button", { name: "מקור" }).click({ timeout: 30_000 });
  await page.getByRole("tab", { name: /קישורים/ }).first().click();
  await page.getByRole("button", { name: "השוואה ומיזוג" }).click();
  const dlg = page.getByRole("dialog");
  const OLD = JSON.stringify([LIB_1, DB_ROWS[0]], null, 2);
  const NEW = JSON.stringify([LIB_1, { ...DB_ROWS[0], heRef_2: "שם מקום אחר לגמרי", ref_2: "Placeholder Ref 1:1" }], null, 2);
  for (const text of [OLD, NEW]) {
    chooser = page.waitForEvent("filechooser");
    await dlg.getByRole("button", { name: /הוספת קובצי/ }).click();
    await (await chooser).setFiles([{ name: NAME, mimeType: "application/json", buffer: Buffer.from(text) }]);
  }
  // two files of the same name: the second is listed as "(2)"; pick by position, the older file first
  await dlg.getByLabel("לפני (א)").selectOption({ index: 0 });
  await dlg.getByLabel("אחרי (ב)").selectOption({ index: 1 });
  await dlg.getByRole("button", { name: "השוואה", exact: true }).click();
  const chips = dlg.locator(".cmp-diff .chip");
  // a ref_2 changed too: not display only, so the "ref" group (V7 §1.7); the display-only group is empty and hidden
  await expect(chips).toHaveText([/^סותרים\s*0$/, /^ציוני ספריא שונים\s*1$/, /^טווחים חופפים\s*0$/, /^רק ב־.*\s0$/, /^רק ב־.*\s0$/, /^זהים\s*1$/]);
  await chips.filter({ hasText: "ציוני ספריא שונים" }).click();
  const row = dlg.locator(".cmp-diff .cmp-table tbody tr");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("שם המקום ביעד: «שם מקום אחר לגמרי»");
  await expect(row).toContainText("ציון ספריא בספר היעד: «Placeholder Ref 1:1»");
  await expect(row).toContainText("ציון ספריא בספר היעד: ריק");
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
