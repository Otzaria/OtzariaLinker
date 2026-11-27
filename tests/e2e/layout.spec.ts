import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * The workspace layout (V5 UX audit U14 and the owner's note "after hiding something there must be a
 * way to show it again"): a window made narrower than 1200px switches to "two texts and a side panel"
 * unless the user chose a layout; everything that can be hidden comes back, and "reset" brings it all.
 */
const BOOK = (title: string, lines: string[]) => ({ name: `${title}.txt`, mimeType: "text/plain", buffer: Buffer.from([`<h1>${title}</h1>`, ...lines].join("\n"), "utf8") });

async function open(page: Page) {
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([BOOK("ספר", ["שורה אחת", "שורה שתיים"]), BOOK("פירוש על ספר", ["שורה אחת - פירוש"])]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 30_000 });
}
const layoutMenu = (page: Page) => page.getByRole("button", { name: /^פריסת סביבת העבודה/ });
const panel = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test("a window made narrower switches to 'two texts and a side panel'; wider again, four columns return", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  await expect(panel(page, "קבצים ומסדים")).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  // the books moved to the side panel's tab
  await expect(panel(page, "קבצים ומסדים")).toHaveCount(0);
  await page.getByRole("tab", { name: "ספרים" }).click();
  await expect(page.locator(".side-panel .book-list li")).toHaveCount(2);
  await expect(page.locator(".notice", { hasText: "החלון צר" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(panel(page, "קבצים ומסדים")).toBeVisible();
  await expect(page.getByRole("tab", { name: "ספרים" })).toHaveCount(0);

  // a layout the user chose is kept, at any width
  await layoutMenu(page).click();
  await page.getByRole("menuitemradio", { name: "מקשר מעל מקושר" }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(panel(page, "קבצים ומסדים")).toBeVisible();
  await layoutMenu(page).click();
  await expect(page.getByRole("menuitemradio", { name: "מקשר מעל מקושר" })).toHaveAttribute("aria-checked", "true");
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("every panel that can be hidden comes back: from the layout menu, from the empty workspace, and by reset", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const hide = (label: string) => page.getByRole("button", { name: `הסתרת ${label}`, exact: true }).click();
  const show = async (label: string) => {
    await layoutMenu(page).click();
    await page.getByRole("menuitem", { name: `הצגת ${label}` }).click();
  };

  // four columns: each panel alone, hidden and shown again from the layout menu (its button counts them)
  for (const [hideLabel, region, menuLabel] of [
    ["קבצים ומסדים", "קבצים ומסדים", "קבצים ומסדים"],
    ["הספר המקשר", "הספר המקשר", "הספר המקשר"],
    ["הספר המקושר", "הספר המקושר", "הספר המקושר"],
    ["החלונית", "בונה וקישורים", "החלונית (בונה, קישורים, הצעות)"],
  ] as const) {
    await hide(hideLabel);
    await expect(panel(page, region)).toHaveCount(0);
    await expect(layoutMenu(page)).toHaveAccessibleName("פריסת סביבת העבודה (פאנל אחד מוסתר)");
    await show(menuLabel);
    await expect(panel(page, region)).toBeVisible();
  }
  await expect(layoutMenu(page)).toHaveAccessibleName("פריסת סביבת העבודה");

  // everything hidden: the workspace itself says so and shows them again
  for (const label of ["קבצים ומסדים", "הספר המקשר", "הספר המקושר", "החלונית"]) await hide(label);
  await expect(layoutMenu(page)).toHaveAccessibleName("פריסת סביבת העבודה (4 פאנלים מוסתרים)");
  await page.getByRole("button", { name: "הצגת כל הפאנלים" }).click();
  for (const region of ["קבצים ומסדים", "הספר המקשר", "הספר המקושר", "בונה וקישורים"]) await expect(panel(page, region)).toBeVisible();

  // "source above target": the target hides alone (it shares the source's column) and comes back there
  await layoutMenu(page).click();
  await page.getByRole("menuitemradio", { name: "מקשר מעל מקושר" }).click();
  await hide("הספר המקושר");
  await expect(panel(page, "הספר המקושר")).toHaveCount(0);
  await expect(panel(page, "הספר המקשר")).toBeVisible();
  await show("הספר המקושר");
  await expect(page.locator(".stack-col .reader")).toHaveCount(2);
  await expect(page.locator(".workspace > .stack-col")).toHaveCount(3);
  await hide("הספר המקשר");
  await expect(panel(page, "הספר המקושר")).toBeVisible();
  await show("הספר המקשר");

  // two texts and a side panel: the books are a tab; shown again as a column, the tab goes
  await layoutMenu(page).click();
  await page.getByRole("menuitemradio", { name: "שני טקסטים וחלונית צד" }).click();
  await expect(page.getByRole("tab", { name: "ספרים" })).toBeVisible();
  await show("קבצים ומסדים");
  await expect(panel(page, "קבצים ומסדים")).toBeVisible();
  await expect(page.getByRole("tab", { name: "ספרים" })).toHaveCount(0);

  // reset: four columns, every panel shown
  await hide("החלונית");
  await hide("הספר המקושר");
  await layoutMenu(page).click();
  await page.getByRole("menuitem", { name: /איפוס הפריסה/ }).click();
  for (const region of ["קבצים ומסדים", "הספר המקשר", "הספר המקושר", "בונה וקישורים"]) await expect(panel(page, region)).toBeVisible();
  await layoutMenu(page).click();
  await expect(page.getByRole("menuitemradio", { name: "ארבעה טורים" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // a side panel's section folded away comes back from the same place: the "add a source" options
  const add = page.getByRole("button", { name: /הוספת קובץ או מסד/ });
  await expect(add).toHaveAttribute("aria-expanded", "false");
  await add.click();
  await expect(add).toHaveAttribute("aria-expanded", "true");
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * Issue 26(b): the side panel dragged to its narrowest painted its content outside itself (the left edge
 * was cut) when a book had a long name with no spaces: the builder's grid tracks were 'auto'/'1fr', whose
 * minimum is the content's min-content, so one unbroken word stretched everything.
 */
test("the side panel at its narrowest keeps every element inside it, even with a long unbroken book name", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    BOOK("ביאורמפורטעלהתורהמאתרבימשהבןמיימוןזלהה", ["שורה אחת", "שורה שתיים"]),
    BOOK("חידושיהרשבאעלמסכתבבאמציעאפרקשני", ["שורה אחת - פירוש"]),
  ]);
  await expect(page.locator(".source-row")).toHaveCount(1, { timeout: 30_000 });

  // the last border is the side panel's; ArrowLeft there shrinks the side panel
  await page.getByRole("separator", { name: "שינוי רוחב הפאנלים" }).last().focus();
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowLeft");
  // both ends picked: the builder then also shows the "stored as" paragraph and the validation list
  const books = page.locator(".book-list li");
  await books.filter({ hasText: "ביאורמפורט" }).first().locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: "חידושיהרשבא" }).first().locator('button.side-btn[data-side="target"]').click();
  await page.locator(".reader.source .ln").nth(1).click();
  await page.locator(".reader.target .ln").nth(1).click();
  await expect(page.locator(".builder .end.set")).toHaveCount(2);

  const side = page.locator(".side-panel");
  const outside = () =>
    side.evaluate((p) => {
      const pb = p.getBoundingClientRect();
      const out: string[] = [];
      p.querySelectorAll("*").forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.width && (b.left < pb.left - 1 || b.right > pb.right + 1)) out.push(`${el.tagName}.${(el as HTMLElement).className}`);
        // a block whose text runs past its own box (clipped by the panel, so the box test alone misses it)
        const cs = getComputedStyle(el);
        if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1 && cs.overflowX === "visible" && cs.display !== "inline") out.push(`scroll:${el.tagName}.${(el as HTMLElement).className}`);
      });
      return out;
    });
  expect((await side.boundingBox())!.width, "the side panel keeps a usable minimum").toBeGreaterThanOrEqual(200);
  expect(await outside()).toEqual([]);
  // the tab strip shows every tab inside the panel, and no tab's content paints outside it either
  const tabs = page.locator(".side-panel .tabs > [role=tablist] > [role=tab]");
  expect(await tabs.count()).toBe(4);
  for (let t = 0; t < 4; t++) {
    const tab = tabs.nth(t);
    await tab.click();
    expect(await outside(), `tab ${t}`).toEqual([]);
    const b = (await tab.boundingBox())!;
    const pb = (await side.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(pb.x - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(pb.x + pb.width + 1);
  }
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * V7 §3.9: the order of the panels changes without a mouse — the arrows on a panel's handle move it one place the way they point
 * (RTL: left is towards the end), the handle keeps the focus, the order is kept after a reload, and "reset" brings the default back.
 */
test("a panel moves by keyboard from its handle; the order is kept after a reload and reset restores it", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page);
  const order = () => page.locator("main.workspace > .stack-col > :first-child").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? e.querySelector("[data-panel]")?.getAttribute("data-panel")));
  const before = await order();
  expect(before).toEqual(["קבצים ומסדים", "הספר המקשר", "הספר המקושר", "בונה וקישורים"]);
  const grip = page.getByRole("button", { name: /^הזזת קבצים ומסדים/ });
  await grip.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(order).toEqual(["הספר המקשר", "קבצים ומסדים", "הספר המקושר", "בונה וקישורים"]);
  await expect(page.getByRole("button", { name: /^הזזת קבצים ומסדים/ })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(order).toEqual(["הספר המקשר", "הספר המקושר", "קבצים ומסדים", "בונה וקישורים"]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(order).toEqual(["הספר המקשר", "קבצים ומסדים", "הספר המקושר", "בונה וקישורים"]);
  // kept with the preferences: after a reload and opening the books again, the same order
  await page.reload();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("otzaria-linker:prefs:v1")!).layout.order)).toEqual(["source", "sources", "target", "side"]);
  await open(page);
  await expect.poll(order).toEqual(["הספר המקשר", "קבצים ומסדים", "הספר המקושר", "בונה וקישורים"]);
  await layoutMenu(page).click();
  await page.getByRole("menuitem", { name: /^איפוס הפריסה/ }).click();
  await expect.poll(order).toEqual(before);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
