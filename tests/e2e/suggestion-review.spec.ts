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

test("filter by method, decide from the keyboard on a row, and take a selection back to pending (V7 §3.11)", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  // the first verses open with the verse's own words (dibur hamatchil and headings both find them), the rest only by their heading
  const openings = ["בראשית ברא", "והארץ היתה תהו", "ויאמר אלהים יהי אור", "וירא אלהים את האור"];
  const biur = ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...HEB.slice(0, 8).flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `${openings[i] ? `${openings[i]} - ` : ""}ביאור לפסוק ${i + 1}`])].join("\n");
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "ביאור על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(biur) },
  ]);
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: "ביאור על בראשית" }).locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("checkbox", { name: /כל השיטות שמתאימות, מאוחדות/ }).check();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  const rows = page.getByRole("table", { name: "הצעות" }).locator("tbody tr");
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "הכול", exact: true }).click();
  const all = await rows.count();

  // two methods ran: the filter is offered (every method, and each one), and narrows to the suggestions that method found
  const byEngine = page.getByRole("combobox", { name: "סינון לפי שיטה" });
  await expect(byEngine.locator("option")).toHaveCount(3);
  await byEngine.selectOption({ index: 2 });
  const fewer = await rows.count();
  expect(fewer).toBeGreaterThan(0);
  expect(fewer).toBeLessThan(all);
  await byEngine.selectOption({ index: 0 });
  await expect(rows).toHaveCount(all);
  // one target book: there is nothing to choose between
  await expect(page.getByRole("combobox", { name: "סינון לפי ספר היעד" })).toHaveCount(0);
  // each confidence chip says what the level means
  await expect(page.locator(".filters .chip.conf-certain")).toHaveAttribute("title", /אישור כל הוודאיות/);

  // the keyboard on a focused row: A approves, U takes it back, R rejects
  const row = rows.first();
  await row.focus();
  await page.keyboard.press("a");
  await expect(row).toHaveClass(/st-approved/);
  await page.keyboard.press("u");
  await expect(row).toHaveClass(/st-pending/);
  await page.keyboard.press("r");
  await expect(row).toHaveClass(/st-rejected/);

  // a selection of decided rows goes back to pending in one step
  await rows.nth(1).locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: /^אישור 1$/ }).click();
  await rows.nth(0).locator("input[type=checkbox]").check();
  await rows.nth(1).locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: "החזרה להמתנה" }).click();
  await expect(rows.nth(0)).toHaveClass(/st-pending/);
  await expect(rows.nth(1)).toHaveClass(/st-pending/);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("a citations search: the bar says its stage, and a cancel keeps the run on the screen with a re-run (#41 B11)", async ({ page }) => {
  const seen = watchPage(page);
  const lines = ["<h1>חיבור גדול</h1>", "<h2>פרק א</h2>", ...Array.from({ length: 40_000 }, (_, i) => `שורה ${i + 1} כמו שנאמר (בראשית א, ${["א", "ב", "ג", "כח"][i % 4]}) ועוד מילים.`)];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) },
    { name: "חיבור גדול.txt", mimeType: "text/plain", buffer: Buffer.from(lines.join("\n")) },
  ]);
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: "חיבור גדול" }).first().locator('button.side-btn[data-side="source"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "מראי מקומות" });
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  const task = page.locator(".app-bar .task");
  // the stage, never a bare bar: preparing, then reading the book
  await expect(task.locator(".task-count")).toHaveText(/מכין|קורא את הספר/);
  await task.getByRole("button", { name: "ביטול" }).click();
  await expect(task).toHaveCount(0, { timeout: 20_000 });
  // the run stays: the form does not come back, and the panel says the run stopped and offers it again
  await expect(page.getByRole("button", { name: "חיפוש התאמות" })).toHaveCount(0);
  const stopped = page.locator(".sug-results li.warning", { hasText: "הריצה נעצרה" });
  await expect(stopped).toBeVisible();
  await stopped.getByRole("button", { name: "הרצה חוזרת" }).click();
  // the whole search this time: it ends by itself, whole
  await expect(stopped).toHaveCount(0, { timeout: 90_000 });
  await expect(page.getByRole("table", { name: "הצעות" }).locator("tbody tr").first()).toBeVisible();
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

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
