import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * Issue #27 in the real single file: the dibur-hamatchil form has a choice of which lines of the commentary enter; the preview says which
 * ones, before anything runs; the run links only those, by the words after the marker.
 */
test("dibur hamatchil: only the lines that start with [א], with a preview of which lines those are", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  const commentary = ["<h1>פירוש על בראשית</h1>", "[א] <b>בראשית ברא אלהים</b> – פירוש ראשון על הדברים", "<b>והארץ היתה תהו</b> – שורה בלי סימן שאינה צריכה להיכנס", "[ב] <b>ויאמר אלהים יהי אור</b> – פירוש שלישי על הדברים"].join("\n");
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "פירוש על בראשית.txt", mimeType: "application/octet-stream", buffer: Buffer.from(commentary) },
  ]);
  await expect(page.locator(".source-row").first()).toBeVisible({ timeout: 30_000 });
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: "פירוש על בראשית" }).first().getByRole("button", { name: "מקור" }).click();
  await books.filter({ hasText: /^בראשית/ }).first().getByRole("button", { name: "יעד" }).click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "לפי דיבור המתחיל" });

  // the choice is there in simple mode (it is part of the method), and the preview appears only once a marker is chosen
  await expect(page.getByRole("button", { name: /תצוגה מקדימה: אילו שורות ייכנסו/ })).toHaveCount(0);
  await page.getByLabel("אילו שורות של הספר המקשר נכנסות").selectOption("square");
  await page.getByRole("button", { name: /תצוגה מקדימה: אילו שורות ייכנסו/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 מתוך 3 שורות ייכנסו" })).toBeVisible();
  await expect(page.getByText("[א]", { exact: false }).first()).toBeVisible();

  // a regular expression of your own: a dangerous one blocks the run, with the reason
  await page.getByLabel("אילו שורות של הספר המקשר נכנסות").selectOption("regex");
  await page.getByLabel("הסימן בתחילת השורה (ביטוי רגולרי)").fill("(a+)+$");
  await expect(page.getByRole("button", { name: "חיפוש התאמות" })).toBeDisabled();
  await page.getByLabel("אילו שורות של הספר המקשר נכנסות").selectOption("square");
  await expect(page.getByRole("button", { name: "חיפוש התאמות" })).toBeEnabled();

  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await page.getByRole("button", { name: "הכול", exact: true }).click({ timeout: 30_000 });
  await expect(page.locator(".sug-table tbody tr")).toHaveCount(2, { timeout: 30_000 });
  expect(seen.errors).toEqual([]);
});
