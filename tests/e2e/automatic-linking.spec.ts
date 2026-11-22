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

/*
 * Issue 8: the table (and the card view) can be sorted — weakest suggestions first, so the ones that need a human eye
 * come before the certain ones — and the choice is kept when the view changes. Default: the book's order.
 */
test("sort the suggestions: weakest first, strongest first, and back to the book's order; the card view follows", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  // Rashi on Bereshit against Bereshit by the opening words (the real database slice): the levels differ from line to line
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) }]);
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: 'רש"י על בראשית' }).first().getByRole("button", { name: "מקור" }).click();
  await books.filter({ hasText: /^בראשית/ }).first().getByRole("button", { name: "יעד" }).click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "לפי דיבור המתחיל" });
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await page.getByRole("button", { name: "הכול", exact: true }).click({ timeout: 30_000 });
  await expect(page.locator("table.sug-table tbody tr").first()).toBeVisible({ timeout: 30_000 });

  const sort = page.getByLabel("מיון ההצעות");
  await expect(sort).toHaveValue("book");
  const levels = () => page.locator("table.sug-table tbody tr .conf").allTextContents();
  const lines = () => page.locator("table.sug-table tbody tr td:nth-child(2)").allTextContents();
  const RANK = ["ודאית", "גבוהה", "אפשרית", "עמומה", "אין התאמה"];
  const book = await lines();
  const bookLevels = await levels();
  expect(new Set(bookLevels).size, "the sample has more than one level").toBeGreaterThan(1);

  await sort.selectOption("worst");
  const worst = (await levels()).map((l) => RANK.indexOf(l));
  expect(worst).toEqual([...worst].sort((a, b) => b - a));
  await expect(page.locator("table.sug-table tbody tr .score").first()).toContainText("%");

  await sort.selectOption("best");
  const best = (await levels()).map((l) => RANK.indexOf(l));
  expect(best).toEqual([...best].sort((a, b) => a - b));
  expect(best[0]).toBe(Math.min(...best));

  // the card view reads the same order: it starts on the table's first row... and stepping goes down the same list
  await page.getByRole("radio", { name: "כרטיס" }).click();
  await expect(page.getByLabel("מיון ההצעות")).toHaveValue("best");
  await expect(page.locator(".builder .conf").first()).toHaveText(RANK[Math.min(...best)]!);

  await page.getByRole("radio", { name: "טבלה" }).click();
  await page.getByLabel("מיון ההצעות").selectOption("book");
  await page.getByRole("button", { name: "הכול", exact: true }).click();
  expect(await lines()).toEqual(book);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

/*
 * Issue 12: both ends of a suggestion are numbered — the source line in its own column, the target line under the place
 * name — in the table, in the one-at-a-time view and on the card, and the number is the one the reader shows.
 */
test("a suggestion shows the target's line number in the table, the step view and the card — the one the reader marks", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) }]);
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: 'רש"י על בראשית' }).first().getByRole("button", { name: "מקור" }).click();
  await books.filter({ hasText: /^בראשית/ }).first().getByRole("button", { name: "יעד" }).click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByLabel("שיטה").selectOption({ label: "לפי דיבור המתחיל" });
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await page.getByRole("button", { name: "הכול", exact: true }).click({ timeout: 30_000 });
  const row = page.locator("table.sug-table tbody tr").nth(2);
  await expect(row).toBeVisible({ timeout: 30_000 });

  await row.click();
  const marked = await page.locator(".reader.target .ln.picked").first().getAttribute("data-i");
  const n = Number(marked) + 1;
  const place = new RegExp(String.raw`שור(?:ה|ות) ${n}(?!\d)`);
  await expect(row.locator("td").nth(2)).toContainText(place);
  await expect(row.getByRole("checkbox")).toHaveAccessibleName(place);

  await page.getByRole("radio", { name: "בתוך הטקסט" }).click();
  await expect(page.locator(".builder .end.source.set")).toContainText(place);
  await page.getByRole("radio", { name: "כרטיס" }).click();
  await expect(page.locator(".builder .end.target.set .side-badge")).toContainText(/שור(?:ה|ות) \d+/);
  await expect(page.locator(".builder .end.source.set .side-badge")).toContainText(/שור(?:ה|ות) \d+/);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
