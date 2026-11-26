import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * From a line in the reader to its links (V5 UX audit, the owner's choice A for "which line goes with
 * which"): the count next to the line opens a small list of its links, each with the other side's book,
 * line and opening words; choosing one shows both ends and keeps them marked. The same by keyboard.
 */
const text = (title: string, lines: string[]) => ({ name: `${title}.txt`, mimeType: "text/plain", buffer: Buffer.from([`<h1>${title}</h1>`, ...lines].join("\n"), "utf8") });
const BASE = text("בראשית", ["בראשית ברא אלהים את השמים ואת הארץ.", "והארץ היתה תהו ובהו.", "ויאמר אלהים יהי אור ויהי אור."]);
const COMM = text("ביאור על בראשית", ["בראשית ברא - ביאור ראשון.", "תהו ובהו - ביאור שני.", "יהי אור - ביאור שלישי."]);
const rec = (l1: number, l2: number) => ({ line_index_1: l1, heRef_2: `בראשית ${l2}`, path_2: "בראשית.txt", line_index_2: l2, "Conection Type": "commentary" });
// line 2 of the commentary has two links (verse 1 and verse 3), line 3 one
const LINKS = { name: "ביאור על בראשית_links.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([rec(2, 2), rec(2, 4), rec(3, 3)]), "utf8") };

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([BASE, COMM, LINKS]);
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: "ביאור על בראשית" }).locator('button.side-btn[data-side="source"]').click({ timeout: 30_000 });
  await books.filter({ hasText: /^בראשית/ }).locator('button.side-btn[data-side="target"]').click();
}
const source = (page: Page) => page.locator(".reader.source");
const target = (page: Page) => page.locator(".reader.target");

test("the count next to a line opens its links; choosing one shows and marks both ends", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  const count = source(page).locator('.ln[data-i="1"] .marks-btn');
  await expect(count).toHaveAccessibleName("הקישורים של שורה 2 (2)");
  await count.click();
  const pop = page.getByRole("dialog", { name: "הקישורים של שורה 2" });
  await expect(pop).toBeVisible();
  await expect(count).toHaveAttribute("aria-expanded", "true");
  const items = pop.locator("button.ll-item");
  await expect(items).toHaveCount(2);
  // the other side's book and line, and the opening words of that line
  await expect(items.nth(0)).toContainText("בראשית 2");
  await expect(items.nth(0)).toContainText("בראשית ברא אלהים");
  await expect(items.nth(1)).toContainText("ויאמר אלהים יהי אור");
  // inside the window, under (or over) the count
  const box = (await pop.boundingBox())!;
  const vw = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vw);
  await items.nth(1).click();
  await expect(pop).toHaveCount(0);
  await expect(target(page).locator(".ln.picked")).toHaveAttribute("data-i", "3");
  await expect(source(page).locator(".ln.picked")).toHaveAttribute("data-i", "1");
  // a click outside closes it
  await count.click();
  await expect(pop).toBeVisible();
  await page.locator(".app-bar").click({ position: { x: 600, y: 20 } });
  await expect(pop).toHaveCount(0);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("by keyboard: Enter on the picked line opens its links, arrows move, Escape returns to the count, Enter chooses", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  const lines = page.getByRole("region", { name: /שורות הספר המקשר/ });
  await lines.focus();
  // the first arrow picks the first line in view; down to line 2 (index 1)
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(source(page).locator(".ln.picked")).toHaveAttribute("data-i", "1");
  const count = source(page).locator('.ln[data-i="1"] .marks-btn');
  // only the picked line's count is a Tab stop
  await expect(count).toHaveAttribute("tabindex", "0");
  await expect(source(page).locator('.ln[data-i="2"] .marks-btn')).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("Enter");
  const pop = page.getByRole("dialog", { name: "הקישורים של שורה 2" });
  const items = pop.locator("button.ll-item");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await expect(count).toBeFocused();
  await expect(count).toHaveAttribute("aria-expanded", "false");
  // the count itself: Space opens, Enter chooses
  await page.keyboard.press("Space");
  await expect(items.nth(0)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(pop).toHaveCount(0);
  await expect(target(page).locator(".ln.picked")).toHaveAttribute("data-i", "1");
  await expect(count).toBeFocused();
  expect(seen.errors).toEqual([]);
});
