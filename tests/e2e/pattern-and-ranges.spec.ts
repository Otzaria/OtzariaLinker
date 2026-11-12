import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * v3 parity, in the built single file: the pattern method (its pattern is shown outside advanced mode
 * too) and range completion of a book from the links tab, undone with Ctrl+Z.
 */
const NL = String.fromCharCode(10);
const MAIN = ["<h1>ספר</h1>", "ראה סימן ב", "וכן סימן ג", "בלי הפניה", "ועיין סימן ה"].join(NL);
const TARGET = ["<h1>שולחן</h1>", "<h2>סימן א</h2>", "טקסט א", "<h2>סימן ב</h2>", "טקסט ב", "<h2>סימן ג</h2>", "טקסט ג"].join(NL);

test("pattern method → approve → range completion → undo", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "ספר.txt", mimeType: "text/plain", buffer: Buffer.from(MAIN) },
    { name: "שולחן.txt", mimeType: "text/plain", buffer: Buffer.from(TARGET) },
  ]);
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ has: page.getByTitle("ספר.txt", { exact: true }) }).getByRole("button", { name: "מקור" }).click();
  await books.filter({ has: page.getByTitle("שולחן.txt", { exact: true }) }).getByRole("button", { name: "יעד" }).click();

  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption("pattern");
  // essential options are visible without advanced mode
  await expect(page.getByLabel("התבנית (ביטוי רגולרי)")).toBeVisible();
  await page.getByLabel("התבנית (ביטוי רגולרי)").fill("(a+)+");
  await expect(page.getByRole("button", { name: "חיפוש התאמות" })).toBeDisabled();
  await page.getByLabel("התבנית (ביטוי רגולרי)").fill("סימן ([א-ת]{1,3})");
  await page.getByLabel("המספר הוא").selectOption("heading");
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();

  const approveAll = page.getByRole("button", { name: /אישור כל הוודאיות/ });
  await expect(approveAll).toBeEnabled({ timeout: 30_000 });
  await expect(approveAll).toContainText("(2)");
  await approveAll.click();
  await expect(page.getByRole("tab", { name: /קישורים/ })).toContainText("2");

  // range completion of the source book, single-line links too: the link on line 2 ("ראה") stops before
  // the next link on line 3; the last one (line 3) runs to the end of the book (line 5)
  await page.getByRole("tab", { name: /קישורים/ }).click();
  await page.getByText("השלמת טווחים").click();
  // the book shown in the source reader is preselected
  await expect(page.locator("details.held", { hasText: "השלמת טווחים" }).locator("select").first()).toHaveValue(/ספר.txt$/);
  await page.getByLabel("רק קישורים שכבר מוגדרים כטווח", { exact: false }).uncheck();
  await page.getByRole("button", { name: "השלמה" }).click();
  await expect(page.getByText(/הושלמו הטווחים של קישור אחד/)).toBeVisible();
  await expect(page.locator(".link-list")).toContainText("3–5");

  await page.keyboard.press("Control+z");
  await expect(page.locator(".link-list")).not.toContainText("3–5");
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
