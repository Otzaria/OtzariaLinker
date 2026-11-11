import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

test("relink: links move to the new edition of a book (stage 11)", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const v1 = ["<h1>ספר</h1>", "שורה ראשונה של הספר", "שורה שנייה של הספר", "שורה שלישית של הספר"];
  const v2 = ["<h1>ספר</h1>", "הקדמה חדשה לגמרי", ...v1.slice(1)];
  const nl = String.fromCharCode(10);
  const links = JSON.stringify([2, 3, 4].map((l) => ({ line_index_1: l, heRef_2: "בסיס", path_2: "בסיס.txt", line_index_2: 1, "Conection Type": "reference" })));
  for (const files of [
    [{ name: "ספר.txt", buffer: Buffer.from(v1.join(nl)) }, { name: "ספר_links.json", buffer: Buffer.from(links) }],
    [{ name: "ספר.txt", buffer: Buffer.from(v2.join(nl)) }],
  ]) {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: /^(קבצים|הוספת מקור)$/ }).first().click(); // home, then the sources panel
    await (await chooser).setFiles(files.map((f) => ({ ...f, mimeType: "text/plain" })));
    await expect(page.locator(".source-row").last()).toBeVisible({ timeout: 30_000 });
  }
  await page.getByRole("tab", { name: /קישורים/ }).click();
  await page.getByRole("button", { name: "מעבר למהדורה חדשה של ספר" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("המהדורה החדשה").selectOption({ index: 1 });
  await dlg.getByRole("button", { name: "השוואה" }).click();
  await dlg.getByRole("button", { name: /העברת הבטוחים \(3\)/ }).click();
  await expect(dlg.getByRole("button", { name: /העברת הבטוחים/ })).toBeDisabled();
  expect(seen.errors).toEqual([]);
});
