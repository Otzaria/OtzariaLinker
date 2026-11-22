import { expect, test } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * 3.8 — the manual editor on a touch screen, without hover or drag: jump to a heading and to a line number in a reader,
 * pick two lines by tapping and make the link with a button, and see which content lines are still unlinked (a mark with
 * a name, not a colour). The context has touch and no mouse.
 */
const nl = String.fromCharCode(10);
const lines = (title: string, n: number) => [`<h1>${title}</h1>`, ...Array.from({ length: n }, (_, i) => (i === 349 ? `<h2>פרק רחוק</h2>` : `שורה ${i + 2} של ${title}`))].join(nl);

test("the manual editor by touch: jump to a heading and to a line, tap two lines and link them, see the unlinked lines", async ({ browser }) => {
  const ctx = await browser.newContext({ locale: "he-IL", offline: true, hasTouch: true, viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const seen = watchPage(page);
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).tap();
  await (await chooser).setFiles([
    { name: "ספר שלי.txt", mimeType: "text/plain", buffer: Buffer.from(lines("ספר שלי", 420)) },
    { name: "ספר יעד.txt", mimeType: "text/plain", buffer: Buffer.from(lines("ספר יעד", 40)) },
  ]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 30_000 });
  const books = page.locator(".book-list li");
  await books.filter({ hasText: /^ספר שלי/ }).first().locator('button.side-btn[data-side="source"]').tap();
  await books.filter({ hasText: /^ספר יעד/ }).first().locator('button.side-btn[data-side="target"]').tap();
  const source = page.locator(".reader.source");
  const target = page.locator(".reader.target");

  // jump to a line number
  await source.getByLabel("מעבר לשורה").fill("380");
  await source.getByLabel("מעבר לשורה").press("Enter");
  await expect(source.locator('.ln[data-i="379"]')).toBeInViewport({ timeout: 15_000 });

  // jump to a heading: the list of the book's headings, a tap on one
  await source.locator("details.heading-jump > summary").tap();
  await source.getByRole("button", { name: /פרק רחוק/ }).tap();
  await expect(source.locator('.ln[data-i="350"]')).toBeInViewport({ timeout: 15_000 });

  // tap a line in each reader, then the button: a link, with no drag and no hover
  await source.getByLabel("מעבר לשורה").fill("5");
  await source.getByLabel("מעבר לשורה").press("Enter");
  await source.locator('.ln[data-i="4"] .tx').tap();
  await target.locator('.ln[data-i="6"] .tx').tap();
  await page.getByRole("button", { name: "יצירת קישור" }).tap();
  await expect(page.getByRole("tab", { name: /קישורים/ }).first()).toContainText("1");

  // the unlinked content lines are marked — by a sign and a name, headings and linked lines are not
  await source.getByRole("checkbox", { name: "סימון שורות בלי קישור" }).check();
  await expect(source.locator('.ln[data-i="4"]')).not.toHaveClass(/unlinked/);
  await expect(source.locator('.ln[data-i="5"]')).toHaveClass(/unlinked/);
  await expect(source.locator('.ln[data-i="0"]')).not.toHaveClass(/unlinked/); // the title heading
  await expect(source.locator('.ln[data-i="5"] .unl')).toHaveAccessibleName("בלי קישור");
  expect(await source.locator('.ln[data-i="5"] .unl').textContent()).toBeTruthy(); // a sign on the line, not a colour
  // linking the line takes its mark away
  await source.locator('.ln[data-i="5"] .tx').tap();
  await target.locator('.ln[data-i="7"] .tx').tap();
  await page.getByRole("button", { name: "יצירת קישור" }).tap();
  await expect(source.locator('.ln[data-i="5"]')).not.toHaveClass(/unlinked/);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
  await ctx.close();
});
