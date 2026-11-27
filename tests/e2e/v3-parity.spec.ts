import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { smallTargets, unnamedControls } from "./a11y";
import { distUrl, watchPage } from "./helpers";

/*
 * Version 3's app-level capabilities that V7 had lost (docs/audit/V7_LEGACY_PARITY.md §3.1), in the built single file, offline:
 * removing one book with its links and undo (F-035), the full reset that never loses work (F-028), the headings of all
 * books (F-139), the target lines no suggestion points at (F-102), the diagnostic log inside the tool (F-137), the density
 * and resetting the settings (F-133, F-131), and no motion for those who asked for none (F-134).
 */
const DB = { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) };
const COMMENTARY = { name: "פירוש על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from("<h1>פירוש על בראשית</h1>\n<h2>פרק ראשון</h2>\nבראשית - פירוש ראשון\nויאמר - פירוש שני\n", "utf8") };

async function open(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(distUrl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([DB, COMMENTARY]);
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: "פירוש על בראשית" }).locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  await expect(page.locator(".reader.target .ln").nth(2)).toContainText("(א)", { timeout: 30_000 });
  return books;
}

async function link(page: Page, s: number, t: number) {
  await page.locator(`.reader.source .ln[data-i="${s}"] .tx`).click();
  await page.locator(`.reader.target .ln[data-i="${t}"] .tx`).click();
  await page.keyboard.press("Control+Enter");
}

const settings = async (page: Page, item: RegExp) => {
  await page.getByRole("button", { name: "הגדרות" }).click();
  await page.getByRole("menuitem", { name: item }).click();
};

test("remove one book with its links, and undo brings both back (F-035)", async ({ page }) => {
  const seen = watchPage(page);
  const books = await open(page);
  await link(page, 2, 2);
  await expect(page.locator('.reader.source .ln[data-i="2"] .mark.new')).toHaveText("1");
  const row = books.filter({ hasText: "פירוש על בראשית" });
  // with a mouse the ✕ shows when its row is pointed at (it takes no room otherwise); Tab reaches it too
  const remove = row.getByRole("button", { name: "הסרת פירוש על בראשית מהכלי" });
  await expect(remove).toBeHidden();
  await remove.focus();
  await expect(remove).toBeVisible();
  await row.hover();
  await remove.click();
  await expect(books.filter({ hasText: "פירוש על בראשית" })).toHaveCount(0);
  const notice = page.locator(".notice", { hasText: '"פירוש על בראשית" הוסר מהכלי' });
  await expect(notice).toContainText("קישור אחד");
  await expect(page.getByRole("button", { name: "ייצוא" })).toBeEnabled(); // the removal itself is an action to undo
  await notice.getByRole("button", { name: "ביטול" }).click();
  await expect(books.filter({ hasText: "פירוש על בראשית" })).toHaveCount(1);
  await books.filter({ hasText: "פירוש על בראשית" }).locator('button.side-btn[data-side="source"]').click();
  await expect(page.locator('.reader.source .ln[data-i="2"] .mark.new')).toHaveText("1");
  // the history names it, and Ctrl+Y removes it again
  await page.keyboard.press("Control+y");
  await expect(books.filter({ hasText: "פירוש על בראשית" })).toHaveCount(0);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("full reset: asks first, saves the project when asked, and unsaved work can be brought back (F-028)", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  await link(page, 2, 2);
  await settings(page, /^איפוס מלא/);
  const dlg = page.getByRole("dialog", { name: "איפוס מלא" });
  await expect(dlg).toContainText("הקבצים במחשב לא ישתנו");
  await expect(dlg).toContainText("עבודה שלא נשמרה");
  expect(await unnamedControls(dlg)).toEqual([]);
  // Esc and "ביטול" change nothing
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(".reader.source")).toBeVisible();
  // with saving: the project file is downloaded first — and, since the tool cannot know the download succeeded, the work
  // is kept aside as well (V7 round-2 review, finding 7)
  await settings(page, /^איפוס מלא/);
  const download = page.waitForEvent("download");
  await page.getByRole("dialog", { name: "איפוס מלא" }).getByRole("button", { name: "שמירת הפרויקט ואיפוס" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.otzlinker\.json$/);
  const savedToo = page.locator(".notice", { hasText: "הכלי אופס. הפרויקט ירד לקובץ" });
  await expect(savedToo).toContainText("אם ההורדה לא הצליחה");
  await expect(savedToo.getByRole("button", { name: "החזרת העבודה" })).toBeVisible();
  await expect(page.locator(".task-card").first()).toBeVisible();
  // without saving: back home, and the work can come back from the notice
  await open(page);
  await link(page, 2, 2);
  await settings(page, /^איפוס מלא/);
  await page.getByRole("dialog", { name: "איפוס מלא" }).getByRole("button", { name: "איפוס בלי שמירה" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator(".task-card").first()).toBeVisible();
  const kept = page.locator(".notice", { hasText: "הכלי אופס. העבודה" });
  await expect(kept).toContainText("נשמרה בצד");
  await kept.getByRole("button", { name: "החזרת העבודה" }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __linker: { allLinks: { value: unknown[] } } }).__linker.allLinks.value.length)).toBe(1);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("the headings of all books: search, and open the book at the heading (F-139)", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  await page.getByRole("button", { name: "חיפוש כותרת בכל הספרים" }).click();
  const dlg = page.getByRole("dialog", { name: "חיפוש כותרת בכל הספרים" });
  await expect(dlg.getByRole("button", { name: /^הספרים שעובדים עליהם/ })).toHaveAttribute("aria-pressed", "true");
  await dlg.getByLabel("חיפוש כותרת").fill("ויאמר");
  await expect(dlg.locator("p[role=status]")).toContainText("לא נמצאה כותרת");
  await dlg.getByLabel("חיפוש כותרת").fill("פרק ראשון");
  const hit = dlg.getByRole("list", { name: "כותרות שנמצאו" }).getByRole("listitem");
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText("פירוש על בראשית");
  // every open book: the whole database is read, then searched
  await dlg.getByRole("button", { name: /^כל הספרים הפתוחים/ }).click();
  await dlg.getByLabel("חיפוש כותרת").fill("בראשית פרק ב");
  await expect(hit.first()).toContainText("בראשית", { timeout: 30_000 });
  expect(await unnamedControls(dlg)).toEqual([]);
  // the button beside a result opens it in the target reader, at the heading
  const line = Number((await hit.first().locator(".hs-open .muted").textContent())!.replace(/\D/g, "")) - 1;
  await hit.first().locator(".side-btn").click();
  await expect(dlg).toHaveCount(0);
  await expect(page.locator(`.reader.target .ln[data-i="${line}"]`)).toBeInViewport();
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("the target lines no suggestion points at, after a dibur-hamatchil run (F-102)", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = (globalThis as unknown as { __linker: any }).__linker;
    const key = (t: string) => [...s.books.value.values()].find((b: { title: string }) => b.title === t).key;
    await s.suggestions.runEngine("dibur-hamatchil", key("פירוש על בראשית"), key("בראשית"));
  });
  const unref = page.locator("details.unref");
  await expect(unref).toBeVisible({ timeout: 30_000 });
  await unref.locator("summary").click();
  await expect(unref).toContainText("בראשית");
  await expect(unref.locator(".unref-body p").first()).not.toContainText("קורא את");
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("the diagnostic log inside the tool: entries, a filter, saving, and Esc gives the focus back (F-137)", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  await settings(page, /^הצגת יומן האבחון/);
  const dlg = page.getByRole("dialog", { name: "יומן האבחון" });
  const log = dlg.getByRole("log");
  await expect(log.locator(".log-row").first()).toBeVisible();
  await expect(log).toContainText("open");
  await expect(log).not.toContainText("פירוש ראשון"); // no book text, ever
  await dlg.getByRole("button", { name: "שגיאות בלבד" }).click();
  await expect(dlg.getByRole("button", { name: "שגיאות בלבד" })).toHaveAttribute("aria-pressed", "true");
  await expect(log).toContainText('בחרו "הכול"');
  const download = page.waitForEvent("download");
  await dlg.getByRole("button", { name: /^שמירה כקובץ/ }).click();
  expect((await download).suggestedFilename()).toMatch(/\.jsonl$/);
  expect(await unnamedControls(dlg)).toEqual([]);
  expect(await smallTargets(dlg)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("density in four levels, and resetting the settings (F-133, F-131)", async ({ page }) => {
  const seen = watchPage(page);
  await open(page);
  const size = () => page.locator(".reader.source .lines").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const normal = await size();
  await page.getByRole("button", { name: "הגדרות" }).click();
  await page.getByRole("menuitemradio", { name: "צפופה מאוד" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-density", "dense");
  expect(await size()).toBeLessThan(normal);
  // kept after a reload
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-density", "dense");
  await page.getByRole("button", { name: "הגדרות" }).click();
  await page.getByRole("menuitemradio", { name: "כהה" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settings(page, /^איפוס ההגדרות/);
  await expect(page.locator("html")).not.toHaveAttribute("data-density", /./);
  await expect(page.locator(".notice", { hasText: "ההגדרות חזרו לברירת המחדל" })).toBeVisible();
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("version 3's settings in this browser are the first settings of this version (F-129)", async ({ page }) => {
  await page.goto(distUrl);
  await page.evaluate(() => {
    localStorage.removeItem("otzaria-linker:prefs:v1");
    localStorage.setItem("otzaria-linker/settings/v2", JSON.stringify({ theme: "dark", density: "compact" }));
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
});

test("no motion for those who asked for none; the line flash stays a cue (F-134)", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page);
  const t = await page.locator(".switch input").evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(parseFloat(t)).toBeLessThan(0.001);
  await page.locator('.reader.source .ln[data-i="2"]').evaluate((el) => el.classList.add("flash"));
  const anim = await page.locator('.reader.source .ln[data-i="2"]').evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).toBe("flash-still");
});

test("the suggestions tab widens the side panel while its width is the preset's (B23)", async ({ page }) => {
  await open(page, 1366);
  const side = page.locator(".side-panel");
  await page.getByRole("tab", { name: /^בונה/ }).click();
  const before = (await side.boundingBox())!.width;
  await page.getByRole("tab", { name: /^הצעות/ }).click();
  await expect.poll(async () => (await side.boundingBox())!.width).toBeGreaterThan(before + 60);
  const reader = (await page.locator(".reader.source").boundingBox())!.width;
  expect((await side.boundingBox())!.width).toBeLessThanOrEqual(reader + 2);
});
