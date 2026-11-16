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
  await expect(panel(page, "מקורות וספרים")).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 768 });
  // the books moved to the side panel's tab
  await expect(panel(page, "מקורות וספרים")).toHaveCount(0);
  await page.getByRole("tab", { name: "ספרים" }).click();
  await expect(page.locator(".side-panel .book-list li")).toHaveCount(2);
  await expect(page.locator(".notice", { hasText: "החלון צר" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(panel(page, "מקורות וספרים")).toBeVisible();
  await expect(page.getByRole("tab", { name: "ספרים" })).toHaveCount(0);

  // a layout the user chose is kept, at any width
  await layoutMenu(page).click();
  await page.getByRole("menuitemradio", { name: "מקור מעל יעד" }).click();
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(panel(page, "מקורות וספרים")).toBeVisible();
  await layoutMenu(page).click();
  await expect(page.getByRole("menuitemradio", { name: "מקור מעל יעד" })).toHaveAttribute("aria-checked", "true");
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
    ["מקורות וספרים", "מקורות וספרים", "מקורות וספרים"],
    ["ספר המקור", "ספר המקור", "ספר המקור"],
    ["ספר היעד", "ספר היעד", "ספר היעד"],
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
  for (const label of ["מקורות וספרים", "ספר המקור", "ספר היעד", "החלונית"]) await hide(label);
  await expect(layoutMenu(page)).toHaveAccessibleName("פריסת סביבת העבודה (4 פאנלים מוסתרים)");
  await page.getByRole("button", { name: "הצגת כל הפאנלים" }).click();
  for (const region of ["מקורות וספרים", "ספר המקור", "ספר היעד", "בונה וקישורים"]) await expect(panel(page, region)).toBeVisible();

  // "source above target": the target hides alone (it shares the source's column) and comes back there
  await layoutMenu(page).click();
  await page.getByRole("menuitemradio", { name: "מקור מעל יעד" }).click();
  await hide("ספר היעד");
  await expect(panel(page, "ספר היעד")).toHaveCount(0);
  await expect(panel(page, "ספר המקור")).toBeVisible();
  await show("ספר היעד");
  await expect(page.locator(".stack-col .reader")).toHaveCount(2);
  await expect(page.locator(".workspace > .stack-col")).toHaveCount(3);
  await hide("ספר המקור");
  await expect(panel(page, "ספר היעד")).toBeVisible();
  await show("ספר המקור");

  // two texts and a side panel: the books are a tab; shown again as a column, the tab goes
  await layoutMenu(page).click();
  await page.getByRole("menuitemradio", { name: "שני טקסטים וחלונית צד" }).click();
  await expect(page.getByRole("tab", { name: "ספרים" })).toBeVisible();
  await show("מקורות וספרים");
  await expect(panel(page, "מקורות וספרים")).toBeVisible();
  await expect(page.getByRole("tab", { name: "ספרים" })).toHaveCount(0);

  // reset: four columns, every panel shown
  await hide("החלונית");
  await hide("ספר היעד");
  await layoutMenu(page).click();
  await page.getByRole("menuitem", { name: /איפוס הפריסה/ }).click();
  for (const region of ["מקורות וספרים", "ספר המקור", "ספר היעד", "בונה וקישורים"]) await expect(panel(page, region)).toBeVisible();
  await layoutMenu(page).click();
  await expect(page.getByRole("menuitemradio", { name: "ארבעה טורים" })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");

  // a side panel's section folded away comes back from the same place: the "add a source" options
  const add = page.getByRole("button", { name: /הוספת מקור/ });
  await expect(add).toHaveAttribute("aria-expanded", "false");
  await add.click();
  await expect(add).toHaveAttribute("aria-expanded", "true");
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
