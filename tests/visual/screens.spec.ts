import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { distUrl, watchPage } from "../e2e/helpers";

/*
 * Visual regression of the main screens (playwright.visual.config.ts: every test runs in light and
 * dark, at 1280, 768 and 390 px). Each test reaches its screen the way the E2E specs do, with the
 * real database slice and small text books, then compares the viewport with the platform's baseline.
 * Nothing on these screens depends on the clock; durations appear only in the advanced max-link
 * report and are masked anyway (`timeMasks`). Notices are cleared before each shot (`snap`).
 */
const DB = { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) };
const nl = String.fromCharCode(10);
const txt = (name: string, lines: string[]) => ({ name, mimeType: "text/plain", buffer: Buffer.from(lines.join(nl), "utf8") });
const HEB = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
const BIUR = txt("ביאור על בראשית.txt", ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])]);

let seen: ReturnType<typeof watchPage>;

test.beforeEach(async ({ page }) => {
  seen = watchPage(page);
  await page.goto(distUrl);
  await expect(page.getByRole("heading", { name: "מה תרצו לעשות?" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
});

test.afterEach(() => {
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

async function openFiles(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([DB, ...files]);
  // under 1200 px the default layout keeps the sources list in the side panel's "books" tab
  const booksTab = page.getByRole("tab", { name: "ספרים" });
  await expect(page.locator(".side-panel")).toBeVisible({ timeout: 30_000 });
  if (await booksTab.isVisible()) await booksTab.click();
  await expect(page.locator(".source-row").first()).toBeVisible({ timeout: 30_000 });
}

async function pickBooks(page: Page, source: string | RegExp, target: string | RegExp) {
  const books = page.locator(".book-list li");
  await books.filter({ hasText: source }).first().getByRole("button", { name: "מקור" }).click();
  await books.filter({ hasText: target }).first().getByRole("button", { name: "יעד" }).click();
  await page.getByRole("tab", { name: "בונה" }).click();
}

/** Anything that shows a time or a duration. */
const timeMasks = (page: Page): Locator[] => [page.locator("summary", { hasText: "שניות" }), page.locator(".ml-steps")];

async function snap(page: Page, name: string) {
  // success/info notices fade by themselves after 5 s, so whether one is still there depends on how
  // long the run took; they are cleared rather than compared
  await page.evaluate(() => ((globalThis as unknown as { __linker: { notices: { value: unknown[] } } }).__linker.notices.value = []));
  await expect(page.locator(".notices .notice")).toHaveCount(0);
  // where the side panel, and under 900 px the whole workspace (one scrolling column), end up
  // scrolled depends on when content grew relative to the last click's scroll-into-view (the max-link
  // report, the suggestions table): always show their top
  await page.evaluate(() => document.querySelectorAll(".workspace, .side-panel .panel-body").forEach((e) => (e.scrollTop = 0)));
  await page.mouse.move(0, 0); // no hover state left on the last clicked control
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await expect(page).toHaveScreenshot(`${name}.png`, { mask: timeMasks(page) });
}

test("home: task cards and the drop strip", async ({ page }) => {
  await snap(page, "home");
});

test("start: a guided workflow asks for its sources step by step", async ({ page }) => {
  await page.getByRole("button", { name: /תיקייה מול אוצריא/ }).click();
  await expect(page.getByRole("dialog", { name: "תיקייה מול אוצריא" })).toBeVisible();
  await snap(page, "start-task");
});

test("workspace: two books, an existing link and two picked lines in the builder", async ({ page }) => {
  await openFiles(page, [txt("פירוש על בראשית.txt", ["<h1>פירוש על בראשית</h1>", "בראשית - פירוש ראשון", "ויאמר - פירוש שני"])]);
  await pickBooks(page, "פירוש על בראשית", /^בראשית/);
  const source = page.locator(".reader.source");
  const target = page.locator(".reader.target");
  await source.locator('.ln[data-i="1"] .tx').click();
  await target.locator('.ln[data-i="2"] .tx').click();
  await page.locator(".builder").getByPlaceholder("Genesis 1:1").fill("Genesis 1:1");
  await page.keyboard.press("Control+Enter");
  await expect(source.locator('.ln[data-i="1"] .mark.new')).toHaveText("1");
  await expect(source.locator('.ln[data-i="2"]')).toHaveClass(/picked/);
  await target.locator('.ln[data-i="3"] .tx').click();
  await expect(page.locator(".builder").getByRole("button", { name: "יצירת קישור" })).toBeEnabled();
  await snap(page, "workspace");
});

test("suggestions: the table after the headings engine ran", async ({ page }) => {
  await openFiles(page, [BIUR]);
  await pickBooks(page, "ביאור על בראשית", /^בראשית/);
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await expect(page.getByRole("button", { name: /אישור כל הוודאיות/ })).toBeEnabled({ timeout: 30_000 });
  await snap(page, "suggestions-table");
});

test("QA: a duplicate and a link to a heading line", async ({ page }) => {
  const rec = (l1: number, l2: number) => ({ line_index_1: l1, heRef_2: "בראשית", path_2: "בראשית.txt", line_index_2: l2, "Conection Type": "reference" });
  await openFiles(page, [
    txt("ספר שלי.txt", ["<h1>ספר שלי</h1>", "שורה ב", "שורה ג", "שורה ד"]),
    { name: "ספר שלי_links.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify([rec(2, 3), rec(2, 3), rec(3, 1)])) },
  ]);
  await page.getByRole("tab", { name: /בדיקה/ }).click();
  await page.getByRole("button", { name: "בדיקת הקישורים" }).click();
  await expect(page.getByText("3 קישורים נבדקו")).toBeVisible();
  await snap(page, "qa");
});

test("export: the confirmation dialog", async ({ page }) => {
  await openFiles(page, [txt("פירוש על בראשית.txt", ["<h1>פירוש על בראשית</h1>", "בראשית - פירוש ראשון", "ויאמר - פירוש שני"])]);
  await pickBooks(page, "פירוש על בראשית", /^בראשית/);
  await page.locator('.reader.source .ln[data-i="1"] .tx').click();
  await page.locator('.reader.target .ln[data-i="2"] .tx').click();
  await page.locator(".builder").getByPlaceholder("Genesis 1:1").fill("Genesis 1:1");
  await page.keyboard.press("Control+Enter");
  await page.getByRole("button", { name: /ייצוא/ }).click();
  await expect(page.getByRole("dialog")).toContainText("פירוש על בראשית_links.json");
  await snap(page, "export-dialog");
});

test("help: F1 opens the guide", async ({ page }) => {
  await page.keyboard.press("F1");
  const help = page.getByRole("dialog", { name: /עזרה/ });
  await expect(help.getByRole("heading", { level: 1 })).toContainText("מדריך למשתמש");
  await snap(page, "help");
});

test("max-link: the report after a run on a folder", async ({ page }) => {
  await openFiles(page, [
    BIUR,
    txt("ספר דוגמה.txt", ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה עם הערה (1) ועוד אחת (2).", "<h2>פרק ב</h2>", "כאן המספור מתחיל שוב (1)."]),
    txt("הערות לספר דוגמה.txt", ["<h1>הערות לספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה בפרק א.", "(2) הערה שנייה בפרק א.", "<h2>פרק ב</h2>", "(1) הערה ראשונה בפרק ב."]),
  ]);
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("radio", { name: "קישור מרבי" }).click();
  await expect(page.getByRole("status").filter({ hasText: "ספרים נבחרו" })).toContainText("6 הרצות");
  await page.getByRole("button", { name: "הפעלת קישור מרבי" }).click();
  await expect(page.locator("details.ml-report")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: /אישור כל הוודאיות/ })).toBeEnabled();
  await snap(page, "maxlink-report");
});
