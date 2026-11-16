import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "../../e2e/helpers";

/*
 * The links table and the comparison at 100K links (V5 task 27), in the installed Chrome, on the
 * built file, offline: a 100,000-record links file of ארצות החיים (tests/fixtures/db/seforim-v7-mini.db
 * for the books) is imported, then the table is opened, searched, sorted, scrolled to its end, all
 * rows are selected and their type changed (one undo step), and two 100K versions are compared.
 * Times are wall clock around Playwright actions (an upper bound: they include the protocol round trip).
 *   npm run build && npx playwright test --config playwright.validation.config.ts links-table-100k
 */
const N = 100_000;
const MEIR = "המאיר לארץ על ארצות החיים";
const records = (shift: number) =>
  JSON.stringify(
    Array.from({ length: N }, (_, i) => ({
      line_index_1: 1 + (i % 700),
      heRef_2: `${MEIR} ${1 + ((i + (i % 10 === 0 ? shift : 0)) % 3000)}`,
      path_2: `${MEIR}.txt`,
      line_index_2: 1 + ((i + (i % 10 === 0 ? shift : 0)) % 3000),
      "Conection Type": i % 3 ? "commentary" : "reference",
    })),
  );

test("100K links: table render, filter, sort, scroll, group action; 100K-vs-100K comparison", async ({ page }) => {
  test.setTimeout(600_000);
  const seen = watchPage(page);
  const t: Record<string, number> = {};
  const time = async (name: string, run: () => Promise<unknown>) => {
    const t0 = Date.now();
    await run();
    t[name] = Date.now() - t0;
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  let chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  const v1 = records(0);
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ארצות החיים_links.json", mimeType: "application/json", buffer: Buffer.from(v1) },
  ]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 120_000 });
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: /^ארצות החיים/ }).getByRole("button", { name: "מקור" }).click({ timeout: 60_000 });

  const items = page.locator(".vlist .link-item");
  const head = page.locator(".lt-head");
  await time("openTabMs", async () => {
    await page.getByRole("tab", { name: /קישורים/ }).first().click();
    await expect(items.first()).toBeVisible({ timeout: 120_000 });
  });
  await expect(head).toContainText("100,000 מוצגים");
  const domRows = await items.count();
  await time("searchMs", async () => {
    await page.getByPlaceholder("חיפוש בשמות ובמקומות…").fill(`${MEIR} 2999`);
    await expect(head).not.toContainText("100,000 מוצגים");
  });
  await page.getByPlaceholder("חיפוש בשמות ובמקומות…").fill("");
  await expect(head).toContainText("100,000 מוצגים");
  await page.getByText("סינון ומיון").click();
  await time("filterTypeMs", async () => {
    await page.locator(".lt-grid").getByLabel("סוג").selectOption({ label: "הפניה" });
    await expect(head).toContainText("33,334 מוצגים");
  });
  await page.locator(".lt-grid").getByLabel("סוג").selectOption({ label: "הכול" });
  await time("sortMs", async () => {
    await page.locator(".lt-grid").getByLabel("מיון").selectOption({ label: "ספר ושורת יעד" });
    await expect(items.first()).toContainText(`${MEIR} 1`);
  });
  await time("scrollEndMs", async () => {
    await page.locator(".vlist").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(items.last()).toContainText("(3000)");
  });
  await time("selectAllMs", async () => {
    await page.locator(".lt-head input[type=checkbox]").check();
    await expect(head).toContainText("100,000 נבחרו");
  });
  await time("groupTypeMs", async () => {
    await page.getByRole("toolbar", { name: "פעולות על הנבחרים" }).getByLabel("שינוי סוג הקשר").selectOption("midrash");
    await expect(items.first()).toContainText("מדרש");
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await time("undoMs", async () => {
    await page.keyboard.press("Control+z");
    await expect(items.first()).not.toContainText("מדרש");
  });

  // two 100K versions of the file, compared in the dialog
  await page.getByRole("button", { name: "השוואה ומיזוג" }).click();
  const dlg = page.getByRole("dialog");
  chooser = page.waitForEvent("filechooser");
  await dlg.getByRole("button", { name: /הוספת קובצי/ }).click();
  await (await chooser).setFiles([{ name: "ארצות החיים_links.json", mimeType: "application/json", buffer: Buffer.from(records(1)) }]);
  await dlg.getByLabel("לפני (א)").selectOption({ label: "הפרויקט" });
  await dlg.getByLabel("אחרי (ב)").selectOption({ label: "⁦ארצות החיים_links.json⁩" });
  await time("compareClickMs", async () => {
    await dlg.getByRole("button", { name: "השוואה", exact: true }).click();
    await expect(dlg.locator(".cmp-diff .chip").first()).toContainText("10,000");
  });
  const diffMs = Number((await dlg.getByText(/ההשוואה נמשכה/).textContent())!.replace(/[^\d]/g, ""));

  console.log(JSON.stringify({ links: N, domRows, ...t, diffMs }, null, 1));
  expect(domRows).toBeLessThan(60);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
