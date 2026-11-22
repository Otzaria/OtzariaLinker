import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/* Every automatic engine runs inside the real worker of the single file and yields suggestions. */

async function open(page: Page, files: { name: string; buffer: Buffer }[]) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles(files.map((f) => ({ ...f, mimeType: "application/octet-stream" })));
  await expect(page.locator(".source-row").first()).toBeVisible({ timeout: 30_000 });
}

async function runEngine(page: Page, source: string | RegExp, target: string | RegExp, engine: string) {
  const books = page.getByRole("region", { name: "קבצים, מסדים וספרים" }).locator(".book-list li");
  await books.filter({ hasText: source }).first().locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: target }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: engine });
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await page.getByRole("button", { name: "הכול", exact: true }).click({ timeout: 30_000 }); // include "already exists"
  await expect(page.locator(".sug-table tbody tr").first()).toBeVisible({ timeout: 30_000 });
}

test("footnotes: markers in the main book are matched to the notes book", async ({ page }) => {
  const seen = watchPage(page);
  const main = ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה עם הערה (1) ועוד אחת (2).", "<h2>פרק ב</h2>", "כאן המספור מתחיל שוב (1)."].join("\n");
  const notes = ["<h1>הערות לספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה בפרק א.", "(2) הערה שנייה בפרק א.", "<h2>פרק ב</h2>", "(1) הערה ראשונה בפרק ב."].join("\n");
  await open(page, [
    { name: "ספר דוגמה.txt", buffer: Buffer.from(main) },
    { name: "הערות לספר דוגמה.txt", buffer: Buffer.from(notes) },
  ]);
  await runEngine(page, /^ספר דוגמה/, "הערות לספר דוגמה", "הערות שוליים");
  await expect(page.locator(".sug-table tbody tr")).toHaveCount(3);
  await page.getByRole("button", { name: /אישור כל הוודאיות/ }).click();
  await expect(page.getByRole("tab", { name: /קישורים/ })).toContainText("3");
  expect(seen.errors).toEqual([]);
});

test("engine settings (advanced): a custom marker tag is passed to the worker; a dangerous regex blocks the run", async ({ page }) => {
  const seen = watchPage(page);
  // <small> markers: the automatic choice (sup, sub, parentheses) would not read them
  const main = ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה <small>1</small> ועוד <small>2</small>.", "<h2>פרק ב</h2>", "שוב <small>1</small>."].join("\n");
  const notes = ["<h1>הערות לספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה.", "(2) הערה שנייה.", "<h2>פרק ב</h2>", "(1) הערה בפרק ב."].join("\n");
  await open(page, [
    { name: "ספר דוגמה.txt", buffer: Buffer.from(main) },
    { name: "הערות לספר דוגמה.txt", buffer: Buffer.from(notes) },
  ]);
  const books = page.getByRole("region", { name: "קבצים, מסדים וספרים" }).locator(".book-list li");
  await books.filter({ hasText: /^ספר דוגמה/ }).first().locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: "הערות לספר דוגמה" }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "הערות שוליים" });
  await page.getByRole("button", { name: "הגדרות השיטה (מצב מתקדם)" }).click();
  await page.locator("summary", { hasText: "הגדרות השיטה" }).click();

  const run = page.getByRole("button", { name: "חיפוש התאמות" });
  await page.getByLabel("סימני ההערות בספר").selectOption("regex");
  await page.getByLabel("הביטוי הרגולרי").fill("(a+)+");
  await expect(page.getByRole("alert").filter({ hasText: "להקפיא" })).toBeVisible();
  await expect(run).toBeDisabled();

  await page.getByLabel("סימני ההערות בספר").selectOption("tag");
  await page.getByLabel("שם התגית").fill("small");
  await expect(page.locator("summary", { hasText: "(1 שונו)" })).toBeVisible();
  await expect(run).toBeEnabled();
  await run.click();
  await expect(page.locator(".sug-table tbody tr")).toHaveCount(3, { timeout: 30_000 });
  expect(seen.errors).toEqual([]);
});

test("dibur hamatchil: Rashi on Bereshit against Bereshit from the real database slice", async ({ page }) => {
  const seen = watchPage(page);
  await open(page, [{ name: "seforim.db", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) }]);
  await runEngine(page, 'רש"י על בראשית', /^בראשית/, "לפי דיבור המתחיל");
  expect(await page.locator(".sug-table tbody tr").count()).toBeGreaterThan(20);
  expect(seen.errors).toEqual([]);
});

test("batch: a folder of commentaries, each against the base its title names", async ({ page }) => {
  const seen = watchPage(page);
  await open(page, [
    { name: "seforim.db", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ביאור על בראשית.txt", buffer: Buffer.from(["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", "<h3>פסוק א</h3>", "ביאור לפסוק הראשון", "<h3>פסוק ב</h3>", "ביאור לפסוק השני"].join("\n")) },
    { name: "חידושים.txt", buffer: Buffer.from("שורה") },
  ]);
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("radio", { name: "ספרים רבים (אצווה)" }).click();
  await page.getByLabel("הקובץ או המסד שבו נמצאים הפירושים").selectOption({ label: "2 קובצי טקסט (2 ספרים)" });
  await expect(page.getByText("זוהו 1 מתוך 2 ספרים")).toBeVisible();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await expect(page.getByRole("table", { name: "הצעות" }).locator("tbody tr").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("summary", { hasText: "סיכום לפי ספר" }).click();
  await expect(page.getByRole("table", { name: "סיכום לפי ספר" })).toContainText("חידושים");
  expect(seen.errors).toEqual([]);
});

/*
 * Issue 14 (screen): how the notes are marked in the book — a tag, brackets or BARE DIGITS — is a choice in basic mode,
 * in the notes method's own form and in max-link's plan (not only behind the advanced switch).
 */
test("notes: the marker style, bare digits included, is offered in basic mode — in the method's form and in max-link", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const main = ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה עם הערה 1 ועוד אחת 2.", "<h2>פרק ב</h2>", "כאן המספור מתחיל שוב 1."].join("\n");
  const notes = ["<h1>הערות לספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה בפרק א.", "(2) הערה שנייה בפרק א.", "<h2>פרק ב</h2>", "(1) הערה ראשונה בפרק ב."].join("\n");
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "ספר דוגמה.txt", mimeType: "text/plain", buffer: Buffer.from(main) },
    { name: "הערות לספר דוגמה.txt", mimeType: "text/plain", buffer: Buffer.from(notes) },
  ]);
  await expect(page.locator(".source-row").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "הערות שוליים" });
  const marker = page.getByLabel("סימני ההערות בספר");
  await expect(marker).toBeVisible();
  await expect(marker.locator("option", { hasText: "מספרים בלי תגית" })).toHaveCount(1);
  await marker.selectOption("digits");
  await expect(marker).toHaveValue("digits");

  await page.getByRole("radio", { name: "קישור מרבי" }).click();
  const section = page.getByRole("region", { name: "הגדרות: הערות שוליים" });
  await expect(section.getByLabel("סימני ההערות בספר")).toBeVisible({ timeout: 15_000 });
  // basic mode: the rest of the notes method's settings stay folded away
  await expect(section.locator("details.engine-options")).toHaveCount(0);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
