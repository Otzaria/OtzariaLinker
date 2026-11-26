import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { distUrl, watchPage } from "./helpers";

/*
 * The alt_toc editor end to end, in the built single file offline: open a book and its links file →
 * links tab → "מבני כותרות" → new structure → fill from the book's headings → gematria numbering →
 * save (undoable) → export: one ZIP with links/, alt_toc/ and _report.txt.
 */
const NL = String.fromCharCode(10);
const BOOK = ["<h1>פרשה א</h1>", "פסוק 1", "<h2>x</h2>", "פסוק 2", "<h2>x</h2>", "פסוק 3", "<h1>פרשה ב</h1>", "<h2>x</h2>", "פסוק 4"].join(NL);
const SHOTS = process.env.SHOTS_DIR;
const LINKS = JSON.stringify([{ line_index_1: 2, heRef_2: "בסיס 1", path_2: "בסיס.txt", line_index_2: 1, "Conection Type": "reference" }]);

test("alt_toc: build a structure from the headings, number it, save, export it with the links", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "חומש שלי.txt", mimeType: "text/plain", buffer: Buffer.from(BOOK) },
    { name: "חומש שלי_links.json", mimeType: "application/json", buffer: Buffer.from(LINKS) },
  ]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 30_000 });

  await page.getByRole("tab", { name: /קישורים/ }).click();
  await page.getByRole("button", { name: /^מבני כותרות/ }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByLabel("הספר")).toHaveValue("חומש שלי");
  await dlg.getByLabel("מפתח המבנה החדש (באנגלית)").fill("Parasha");
  await dlg.getByRole("button", { name: "מבנה חדש" }).click();
  await dlg.getByLabel("שם התצוגה של המבנה").fill("פרשה");
  await dlg.getByRole("button", { name: "מילוי מכותרות הספר" }).click();
  await expect(dlg.getByLabel("כותרת צומת 5")).toHaveValue("x");
  await dlg.getByRole("button", { name: "מספור בגימטריה" }).click();
  await expect(dlg.getByLabel("כותרת צומת 2")).toHaveValue("עליה א");
  await expect(dlg.getByLabel("כותרת צומת 3")).toHaveValue("עליה ב");
  await expect(dlg.getByLabel("כותרת צומת 5")).toHaveValue("עליה א");
  await expect(dlg.getByLabel("שורה של עליה ב", { exact: true })).toHaveValue("5");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/alt-toc-editor.png` });
  await dlg.getByRole("button", { name: "שמירה" }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole("button", { name: "מבני כותרות (1)" })).toBeVisible();

  // one undoable action
  await page.getByRole("button", { name: "ביטול הפעולה האחרונה" }).click();
  await expect(page.getByRole("button", { name: "מבני כותרות", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "ביצוע חוזר" }).click();
  await expect(page.getByRole("button", { name: "מבני כותרות (1)" })).toBeVisible();

  await page.getByRole("button", { name: /^ייצוא/ }).click();
  const exp = page.getByRole("dialog");
  await expect(exp).toContainText("alt_toc/חומש שלי_alt_toc.json");
  await expect(exp).toContainText("חומש שלי_links.json");
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/alt-toc-export.png` });
  const download = page.waitForEvent("download");
  await exp.getByRole("button", { name: "הורדת ZIP" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^links-\d{4}-\d\d-\d\d\.zip$/);
  const zip = unzipSync(readFileSync((await file.path())!));
  expect(Object.keys(zip).sort()).toEqual(["_report.txt", "alt_toc/חומש שלי_alt_toc.json", "links/חומש שלי_links.json"]);
  expect(JSON.parse(strFromU8(zip["alt_toc/חומש שלי_alt_toc.json"]!))).toEqual([
    {
      key: "Parasha",
      heTitle: "פרשה",
      nodes: [
        { heTitle: "פרשה א", line: 1, children: [{ heTitle: "עליה א", line: 3 }, { heTitle: "עליה ב", line: 5 }] },
        { heTitle: "פרשה ב", line: 7, children: [{ heTitle: "עליה א", line: 8 }] },
      ],
    },
  ]);
  expect(strFromU8(zip["_report.txt"]!)).toContain("alt_toc/חומש שלי_alt_toc.json  (1 מבנים, 5 צמתים)");
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

/*
 * #26 (OtzariaLinker issue 25): on a small screen the node table collapsed to a sliver and the open
 * errors list took the rest. The table keeps room for at least three rows and scrolls inside itself,
 * the errors list is bounded and scrolls, and the column headers stay in view.
 */
for (const size of [{ width: 360, height: 560 }, { width: 1024, height: 600 }]) {
  test(`alt_toc: the node table keeps its room and scrolls inside, errors bounded, headers sticky (${size.width}x${size.height})`, async ({ page }) => {
    const seen = watchPage(page);
    // open at the wide default layout (where the sources list is visible), then shrink the window
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(distUrl);
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "קבצים", exact: true }).click();
    await (await chooser).setFiles([{ name: "חומש שלי.txt", mimeType: "text/plain", buffer: Buffer.from(BOOK) }]);
    await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 30_000 });
    await page.setViewportSize(size);
    await page.getByRole("tab", { name: /קישורים/ }).click();
    await page.getByRole("button", { name: /^מבני כותרות/ }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("מפתח המבנה החדש (באנגלית)").fill("Parasha");
    await dlg.getByRole("button", { name: "מבנה חדש" }).click();
    for (let i = 0; i < 14; i++) await dlg.getByRole("button", { name: "הוספת צומת" }).click();
    await expect(dlg.getByLabel("כותרת צומת 14")).toBeVisible();

    const rows = dlg.locator(".alt-rows");
    const rowH = (await dlg.locator(".alt-row").first().boundingBox())!.height;
    const box = (await rows.boundingBox())!;
    expect(box.height, "the node table keeps room for three rows").toBeGreaterThanOrEqual(rowH * 3);
    expect(await rows.evaluate((el) => el.scrollHeight > el.clientHeight), "the table scrolls inside itself").toBe(true);

    // 14 empty titles = 14 errors, open by default: bounded, scrolls inside
    const list = dlg.locator("details.held ul.problems");
    await expect(list).toBeVisible();
    expect((await list.boundingBox())!.height, "the errors list is bounded").toBeLessThanOrEqual(size.height * 0.34);
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    // the dialog body (not the page) scrolls, and nothing scrolls sideways
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(await dlg.locator(".body").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

    // sticky column headers: after scrolling the table to the bottom the header is still at its top edge
    const head = dlg.locator(".alt-head");
    await expect(head).toBeVisible();
    await rows.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const h = (await head.boundingBox())!;
    const r = (await rows.boundingBox())!;
    expect(h.y - r.y, "header stays at the top of the scrolled table").toBeLessThan(12);

    // editing still works
    await dlg.getByLabel("כותרת צומת 14").fill("סוף");
    await expect(dlg.getByLabel("כותרת צומת 14")).toHaveValue("סוף");
    await dlg.getByRole("button", { name: "שמירה" }).scrollIntoViewIfNeeded();
    await expect(dlg.getByRole("button", { name: "שמירה" })).toBeVisible();
    expect(seen.external).toEqual([]);
    expect(seen.errors).toEqual([]);
  });
}

/*
 * 3.11: why alternative headings exist and when one is needed — in the dialog, and true to the generator: the structures
 * Otzaria builds itself are named (a file would duplicate them), and any file stops its automatic "Chapters".
 */
test("alt_toc: the dialog explains what a structure is for, when it is needed and when it would be a duplicate", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "חומש שלי.txt", mimeType: "text/plain", buffer: Buffer.from(BOOK) }]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole("tab", { name: /קישורים/ }).click();
  await page.getByRole("button", { name: /^מבני כותרות/ }).click();
  const why = page.getByRole("dialog").locator("details.alt-why");
  await expect(why.locator("summary")).toContainText("למה יש מבנים אלטרנטיביים");
  await why.locator("summary").click();
  await expect(why).toContainText("מתי צריך");
  await expect(why).toContainText("מתי לא");
  for (const key of ["Seifim", "Topic", "SimanNames", "Chapters"]) await expect(why).toContainText(key);
  await expect(why).toContainText("יכפיל");
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * #25 / V7 §3.18: reorder a node, add one right after another, move a node with its children one level in or out — from one
 * toolbar on the focused node, and Alt+arrows — and no node is lost: closing (Escape or "ביטול") with changes asks first, and the
 * book cannot be switched under unsaved changes.
 */
test("alt_toc: add after, reorder and re-level nodes; closing with unsaved changes asks first", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name: "חומש שלי.txt", mimeType: "text/plain", buffer: Buffer.from(BOOK) }]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 30_000 });
  await page.getByRole("tab", { name: /קישורים/ }).click();
  await page.getByRole("button", { name: /^מבני כותרות/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("מפתח המבנה החדש (באנגלית)").fill("Parasha");
  await dlg.getByRole("button", { name: "מבנה חדש" }).click();
  await dlg.getByRole("button", { name: "מילוי מכותרות הספר" }).click();
  await expect(dlg.getByLabel("כותרת צומת 5")).toHaveValue("x");
  await expect(dlg.getByLabel("הספר")).toBeDisabled();
  const title = (i: number) => dlg.getByLabel(`כותרת צומת ${i}`);
  const tools = dlg.getByRole("toolbar");

  // add right after node 2, name it
  await title(2).fill("עליה");
  await tools.getByRole("button", { name: "צומת חדש אחריו" }).click();
  await expect(title(3)).toBeFocused();
  await title(3).fill("חדש");
  await expect(title(4)).toHaveValue("x");
  // up, then down by keyboard
  await tools.getByRole("button", { name: "למעלה" }).click();
  await expect(title(2)).toHaveValue("חדש");
  await expect(title(3)).toHaveValue("עליה");
  await title(2).press("Alt+ArrowDown");
  await expect(title(3)).toHaveValue("חדש");
  await expect(title(3)).toBeFocused();
  // the first heading one level in takes the nodes under it along; out again
  await title(1).focus();
  await tools.getByRole("button", { name: "רמה פנימה" }).click();
  await expect(dlg.getByLabel("רמה של פרשה א")).toHaveValue("1");
  await expect(dlg.getByLabel("רמה של עליה", { exact: true })).toHaveValue("2");
  await expect(dlg.getByLabel("רמה של פרשה ב")).toHaveValue("0");
  await tools.getByRole("button", { name: "רמה החוצה" }).click();
  await expect(dlg.getByLabel("רמה של פרשה א")).toHaveValue("0");

  // Escape with changes: asks, and "back" keeps every node
  await page.keyboard.press("Escape");
  const ask = dlg.getByRole("alert").filter({ hasText: "שינויים שלא נשמרו" });
  await expect(ask).toBeVisible();
  await expect(ask.getByRole("button", { name: "חזרה לעריכה" })).toBeFocused();
  await ask.getByRole("button", { name: "חזרה לעריכה" }).click();
  await expect(dlg).toBeVisible();
  await expect(title(6)).toHaveValue("x");
  await dlg.getByRole("button", { name: "ביטול" }).click();
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "סגירה בלי שמירה" }).click();
  await expect(dlg).toBeHidden();
  await expect(page.getByRole("button", { name: "מבני כותרות", exact: true })).toBeVisible();
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
