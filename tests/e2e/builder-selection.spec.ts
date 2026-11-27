import { expect, test, type Locator, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * v3's reader and builder capabilities restored in V7 (docs/audit/V7_LEGACY_PARITY.md §3.1, §5), in the real single
 * file, offline from file://: several lines with Ctrl/Cmd and a link from each in one step (F-046/F-061), the range end
 * typed, to the end of the book and the range settings (F-054/F-055/F-079/F-083), the anchor's label (F-075), and the
 * lost keys (§16): PgUp/PgDn/Home/End in the lines, Ctrl+Space, Escape that cancels an edit, Ctrl+E.
 */
const text = (title: string, lines: string[]) => ({ name: `${title}.txt`, mimeType: "text/plain", buffer: Buffer.from([`<h1>${title}</h1>`, ...lines].join("\n"), "utf8") });
// 40 lines of text with a chapter heading at line 21 (0-based 20)
const MAIN = text("ספר הבדיקה", Array.from({ length: 39 }, (_, i) => (i === 19 ? "<h2>פרק ב</h2>" : `שורה מספר ${i + 1} של הספר`)));
const NOTES = text("הערות לספר הבדיקה", ["הערה ראשונה", "הערה שנייה", "הערה שלישית"]);

async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([MAIN, NOTES]);
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: /^ספר הבדיקה/ }).locator('button.side-btn[data-side="source"]').click({ timeout: 30_000 });
  await books.filter({ hasText: "הערות לספר הבדיקה" }).locator('button.side-btn[data-side="target"]').click();
  await expect(source(page).locator('.ln[data-i="38"]')).toHaveCount(1, { timeout: 30_000 });
}
const source = (page: Page) => page.locator(".reader.source");
const target = (page: Page) => page.locator(".reader.target");
const builder = (page: Page) => page.locator(".builder");
const ln = (side: Locator, i: number) => side.locator(`.ln[data-i="${i}"] .tx`);

test("Ctrl/Cmd+click picks several lines, and one action makes a link from each — one undo takes them all back", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  await ln(source(page), 1).click();
  await ln(source(page), 3).click({ modifiers: ["ControlOrMeta"] });
  await ln(source(page), 6).click({ modifiers: ["ControlOrMeta"] });
  await expect(source(page).locator(".ln.picked")).toHaveCount(3);
  await expect(builder(page).locator(".end.source")).toContainText("3 שורות: 2, 4, 7");
  // Ctrl on a picked line takes it out
  await ln(source(page), 3).click({ modifiers: ["ControlOrMeta"] });
  await expect(source(page).locator(".ln.picked")).toHaveCount(2);
  await ln(source(page), 3).click({ modifiers: ["ControlOrMeta"] });

  await ln(target(page), 2).click();
  const create = builder(page).getByRole("button", { name: "יצירת 3 קישורים" });
  await expect(create).toBeEnabled();
  await create.click();
  for (const i of [1, 3, 6]) await expect(source(page).locator(`.ln[data-i="${i}"] .mark.new`)).toHaveText("1");
  await expect(target(page).locator('.ln[data-i="2"] .mark.new')).toHaveText("3");

  await page.getByRole("button", { name: "ביטול הפעולה האחרונה" }).click();
  await expect(source(page).locator(".mark.new")).toHaveCount(0);

  // by keyboard: Ctrl+arrows move a cursor, Ctrl+Space adds its line
  await ln(source(page), 10).click();
  const lines = source(page).getByRole("region", { name: /^שורות/ });
  await lines.focus();
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await expect(source(page).locator('.ln[data-i="12"]')).toHaveClass(/cursor/);
  await page.keyboard.press("Control+Space");
  await expect(source(page).locator(".ln.picked")).toHaveCount(2);
  await expect(builder(page).locator(".end.source")).toContainText("2 שורות: 11, 13");

  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("several target lines: the place field is off and says why — each link gets its own line's place (V7 round-2 review, finding 1)", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  await ln(source(page), 1).click();
  await ln(target(page), 1).click();
  const place = builder(page).getByRole("textbox", { name: /^שם המקום/ });
  await expect(place).toBeEnabled();
  await ln(target(page), 2).click({ modifiers: ["ControlOrMeta"] });
  await ln(target(page), 3).click({ modifiers: ["ControlOrMeta"] });
  await expect(place).toBeDisabled();
  await expect(place).toHaveValue("");
  await expect(builder(page)).toContainText("נבחרו כמה שורות");
  await builder(page).getByRole("button", { name: "יצירת 3 קישורים" }).click();
  for (const i of [1, 2, 3]) await expect(target(page).locator(`.ln[data-i="${i}"] .mark.new`)).toHaveText("1");
  // one line again: the field is back
  await ln(source(page), 4).click();
  await ln(target(page), 1).click();
  await expect(place).toBeEnabled();
  await expect(builder(page)).not.toContainText("נבחרו כמה שורות");
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("the range end typed, until the end of the book, until the next heading; the range settings", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  const end = builder(page).locator(".end.source");
  await ln(source(page), 2).click();
  const typed = end.getByRole("spinbutton", { name: /סוף הטווח/ });
  await typed.fill("6");
  await typed.press("Enter");
  await expect(end).toContainText("שורות 3–6");
  await expect(source(page).locator(".ln.picked")).toHaveCount(4);
  // past the book: refused, with the reason, and the range stays
  await typed.fill("999");
  await typed.press("Enter");
  await expect(page.locator(".notice", { hasText: "בספר יש 40 שורות" })).toBeVisible();
  await expect(end).toContainText("שורות 3–6");
  await end.getByRole("button", { name: "עד סוף הספר" }).click();
  await expect(end).toContainText("שורות 3–40");
  await end.getByRole("button", { name: "בלי טווח" }).click();
  await expect(end).toContainText("שורה 3");
  await expect(typed).toHaveValue("");

  // what "until the next" stops at: a heading only (line 21 is a chapter heading)
  await builder(page).locator(".range-settings > summary").click();
  await builder(page).getByRole("combobox", { name: /עוצר לפני/ }).selectOption("headings");
  await end.getByRole("button", { name: "טווח עד הכותרת הבאה" }).click();
  await expect(end).toContainText("שורות 3–20");

  // the automatic range of the source side: a pick runs by itself to the line before the next marker
  await builder(page).getByRole("checkbox", { name: /טווח אוטומטי/ }).first().check();
  await ln(source(page), 24).click();
  await expect(end).toContainText("שורות 25–40");

  // trimming the previous range off: a new link inside a range leaves the range as it was
  await builder(page).getByRole("checkbox", { name: /טווח אוטומטי/ }).first().uncheck();
  await builder(page).getByRole("combobox", { name: /עוצר לפני/ }).selectOption("auto");
  await ln(source(page), 2).click();
  await typed.fill("10");
  await typed.press("Enter");
  await ln(target(page), 1).click();
  await builder(page).getByRole("button", { name: "יצירת קישור" }).click();
  await builder(page).getByRole("checkbox", { name: "קיצור הטווח הקודם" }).uncheck();
  await ln(source(page), 5).click();
  await ln(target(page), 2).click();
  await builder(page).getByRole("button", { name: "יצירת קישור" }).click();
  await expect(source(page).locator('.ln[data-i="8"] .mark.new')).toHaveText("1");
  await expect(source(page).locator('.ln[data-i="5"] .mark.new')).toHaveText("2");

  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("what was there stays: Shift+click picks a range, and 'until the next link' stops one line before it", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  const end = builder(page).locator(".end.source");
  await ln(source(page), 12).click();
  await ln(target(page), 1).click();
  await builder(page).getByRole("button", { name: "יצירת קישור" }).click();
  await ln(source(page), 2).click();
  await ln(source(page), 5).click({ modifiers: ["Shift"] });
  await expect(end).toContainText("שורות 3–6");
  await expect(source(page).locator(".ln.picked")).toHaveCount(4);
  await ln(source(page), 8).click();
  await end.getByRole("button", { name: "טווח עד הקישור הבא" }).click();
  await expect(end).toContainText("שורות 9–12");
  await expect(end.getByRole("spinbutton", { name: /סוף הטווח/ })).toHaveValue("12");

  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("the anchor's label: written into the place name as ' אות X', replaced, refused when Otzaria would ignore it", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  await ln(target(page), 1).click();
  // mark the words "מספר 3" in source line 3 and click: the anchor
  await page.evaluate(() => {
    const tx = document.querySelector('.reader.source .ln[data-i="3"] .tx')!;
    const node = tx.firstChild!;
    const at = node.textContent!.indexOf("מספר");
    getSelection()!.setBaseAndExtent(node, at, node, at + 6);
    tx.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  const end = builder(page).locator(".end.source");
  await expect(end.locator("mark.anchor-hl")).toHaveText("מספר 3");
  const label = end.getByRole("textbox", { name: "תווית העוגן" });
  await expect(label).toHaveAccessibleDescription(/אות ג/);
  const place = builder(page).getByRole("textbox", { name: /^שם המקום/ });
  const auto = await place.inputValue();
  await label.fill("ג");
  await label.press("Enter");
  await expect(place).toHaveValue(`${auto} אות ג`);
  await label.fill("ד");
  await label.press("Enter");
  await expect(place).toHaveValue(`${auto} אות ד`);
  await label.fill("12");
  await label.press("Enter");
  await expect(end.getByRole("alert")).toContainText("אותיות עבריות");
  await expect(place).toHaveValue(`${auto} אות ד`);
  await label.fill("");
  await label.press("Enter");
  await expect(place).toHaveValue(auto);

  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("the line keys: Home, End, PgDn, PgUp and Shift+End; Escape cancels an edit; Ctrl+E opens the export", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  const lines = source(page).getByRole("region", { name: /^שורות/ });
  // no links yet: Ctrl+E says why nothing opens
  await lines.focus();
  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.locator(".notice", { hasText: "אין עדיין מה לייצא" })).toBeVisible();

  await page.keyboard.press("End");
  await expect(source(page).locator(".ln.picked")).toHaveAttribute("data-i", "39");
  await page.keyboard.press("Home");
  await expect(source(page).locator(".ln.picked")).toHaveAttribute("data-i", "0");
  // a page is the lines the reader shows (less one), not a fixed count
  const picked = async () => Number(await source(page).locator(".ln.picked").getAttribute("data-i"));
  await page.keyboard.press("PageDown");
  await expect.poll(picked).toBeGreaterThan(1);
  const down = await picked();
  await page.keyboard.press("PageUp");
  await expect.poll(picked).toBeLessThan(down);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+End");
  await expect(source(page).locator(".ln.picked")).toHaveCount(39);

  // a link, then an edit that is cancelled with Escape: the link stays where it was
  await ln(source(page), 4).click();
  await ln(target(page), 1).click();
  await builder(page).getByRole("button", { name: "יצירת קישור" }).click();
  await page.getByRole("tab", { name: /קישורים/ }).click();
  await page.locator(".link-item").first().getByRole("button", { name: "עריכה" }).click();
  await expect(builder(page).getByRole("button", { name: "שמירת השינויים" })).toBeVisible();
  await ln(source(page), 8).click();
  await expect(builder(page).locator(".end.source")).toContainText("שורה 9");
  await page.keyboard.press("Escape");
  await expect(builder(page).getByRole("button", { name: "יצירת קישור" })).toBeVisible();
  await expect(page.locator(".notice", { hasText: "העריכה בוטלה" })).toBeVisible();
  await expect(source(page).locator('.ln[data-i="4"] .mark.new')).toHaveText("1");
  await expect(source(page).locator('.ln[data-i="8"] .mark.new')).toHaveCount(0);

  // Ctrl+E: the export dialog, as its button opens it
  await lines.focus();
  await page.keyboard.press("ControlOrMeta+e");
  await expect(page.getByRole("dialog", { name: /ייצוא/ })).toBeVisible();

  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
