import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { clippedControls, focused, horizontalOverflow, lowContrast, smallTargets, unnamedControls } from "./a11y";
import { chooseTask, distUrl, watchPage } from "./helpers";

/*
 * Pre-merge audit of the screens PR 3 added or rebuilt (home, repository analysis, book picker, alt_toc dialog, the per-pair
 * matrix, the suggestions list), on a phone-width window (360x640) and a narrow tablet (768 wide): nothing scrolls sideways or
 * is out of reach, every control has a name and a target of at least 24 px, text keeps AA contrast in light and dark, the
 * page is right-to-left — and with the keyboard alone: focus is always visible, a dialog keeps focus and closes with Escape,
 * Space and Enter work. Screenshots are not compared here (tests/visual does that, with synthetic books); these are assertions.
 */
const nl = String.fromCharCode(10);
const HEB = ["א", "ב", "ג", "ד", "ה"];
const DB_FILE = resolve("tests/fixtures/db/seforim-v7-mini.db");
const DB = { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(DB_FILE) };
const commentary = (t: string) => [`<h1>${t}</h1>`, "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `${t}: ביאור לפסוק ${i + 1}`])];
const BOOKS: Record<string, string[]> = {
  "ביאור על בראשית": commentary("ביאור על בראשית"),
  "פירוש קצר על בראשית": ["<h1>פירוש קצר על בראשית</h1>", "הערה כללית אחת", "הערה כללית שנייה"],
};
const ALT_BOOK = ["<h1>פרשה א</h1>", "פסוק 1", "<h2>x</h2>", "פסוק 2", "<h2>x</h2>", "פסוק 3", "<h1>פרשה ב</h1>", "<h2>x</h2>", "פסוק 4"].join(nl);
const ALT_LINKS = JSON.stringify([{ line_index_1: 2, heRef_2: "בסיס 1", path_2: "בסיס.txt", line_index_2: 1, "Conection Type": "reference" }]);

const SIZES = [
  { name: "360x640", width: 360, height: 640 },
  { name: "768x1024", width: 768, height: 1024 },
] as const;

function folder(name: string): string {
  const dir = join(test.info().outputPath(), name);
  mkdirSync(dir, { recursive: true });
  for (const [title, lines] of Object.entries(BOOKS)) writeFileSync(join(dir, `${title}.txt`), lines.join(nl), "utf8");
  return dir;
}

/** waits until nothing finite is animating (a theme switch starts transitions; measuring mid-transition gives false contrast failures) */
async function settled(page: Page, quietMs: number) {
  await page.evaluate(async (quietMs) => {
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const finite = () => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().endTime !== Infinity);
    const end = performance.now() + 6000;
    let quietSince = performance.now();
    while (performance.now() < end) {
      await frame();
      const running = finite();
      if (running.length || document.querySelector(".ln.flash")) {
        await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 1500))]);
        quietSince = performance.now();
      } else if (performance.now() - quietSince >= quietMs) return;
    }
  }, quietMs);
}

/** One screen: right-to-left, no sideways scroll, nothing out of reach, named controls, 24 px targets, AA contrast in both themes. */
async function audit(page: Page, what: string, targets?: Locator) {
  await settled(page, 300);
  const body = page.locator("body");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).direction), `${what}: direction`).toBe("rtl");
  expect(await horizontalOverflow(page), `${what}: the page scrolls sideways`).toBeLessThanOrEqual(0);
  // a dialog's own body must not scroll sideways either (the page behind is hidden, so the page check misses it)
  const dialogOverflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("dialog[open] .body, dialog[open] .dlg")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => `${e.className}: ${e.scrollWidth}>${e.clientWidth}`));
  expect(dialogOverflow, `${what}: a dialog scrolls sideways`).toEqual([]);
  expect(await clippedControls(page), `${what}: controls out of reach`).toEqual([]);
  expect(await unnamedControls(body), `${what}: controls without a name`).toEqual([]);
  const root = targets ?? ((await page.locator("dialog[open]").count()) ? page.locator("dialog[open]").last() : page.locator("main").first());
  expect(await smallTargets(root), `${what}: targets under 24x24`).toEqual([]);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await settled(page, 50);
    expect(await lowContrast(body), `${what} (${theme}): text under AA contrast`).toEqual([]);
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
}

async function openRepository(page: Page) {
  await chooseTask(page, "repo", "analyze");
  const sheet = page.getByRole("dialog", { name: "ניתוח מאגר והשלמת קישורים" });
  const chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "המסד: מסד נתונים" }).click();
  await (await chooser).setFiles(DB_FILE);
  await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/, { timeout: 30_000 });
  await sheet.getByRole("button", { name: "התחלה" }).click();
  const dlg = page.locator("dialog.repository");
  await expect(dlg).toBeVisible();
  return dlg;
}

async function analyzed(page: Page) {
  const dlg = await openRepository(page);
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  return dlg;
}

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("home and the first question of a path", async ({ page }) => {
      test.slow();
      const seen = watchPage(page);
      await page.goto(distUrl);
      await audit(page, "home");
      await page.locator('.task-card[data-path="auto"]').click();
      await expect(page.getByRole("dialog", { name: "קישור אוטומטי" })).toBeVisible();
      await audit(page, "home: the path's choice");
      await page.keyboard.press("Escape");
      expect(seen.errors).toEqual([]);
      expect(seen.external).toEqual([]);
    });

    test("repository analysis: counts, one book's details, suggested pairs", async ({ page }) => {
      test.slow();
      const seen = watchPage(page);
      await page.goto(distUrl);
      const dlg = await analyzed(page);
      await audit(page, "repository: counts");
      await dlg.getByLabel("חיפוש ספר").fill("ארצות החיים");
      await dlg.locator(".repo-book").first().getByRole("button", { name: /^פרטי הספר/ }).click();
      await expect(dlg.getByRole("region", { name: /^פרטי הספר/ })).toBeVisible();
      await audit(page, "repository: a book's details");
      await dlg.getByRole("button", { name: "סגירת הפרטים" }).click();
      await dlg.getByLabel("חיפוש ספר").fill("");
      await dlg.getByRole("button", { name: "הצעת זוגות לפי השמות" }).click();
      await dlg.getByLabel("גם ספרים שכבר מקושרים").check();
      await expect(dlg.locator(".repo-pair").first()).toBeVisible({ timeout: 30_000 });
      await audit(page, "repository: suggested pairs");
      expect(seen.errors).toEqual([]);
      expect(seen.external).toEqual([]);
    });

    test("book picker (max-link: books I choose) and the suggestions list", async ({ page }) => {
      test.slow();
      const seen = watchPage(page);
      await page.goto(distUrl);
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "קבצים", exact: true }).click();
      await (await chooser).setFiles([DB, ...Object.entries(BOOKS).map(([t, l]) => ({ name: `${t}.txt`, mimeType: "text/plain", buffer: Buffer.from(l.join(nl)) }))]);
      await expect(page.locator(".side-panel")).toBeVisible({ timeout: 30_000 });
      const booksTab = page.getByRole("tab", { name: "ספרים" });
      if (await booksTab.isVisible()) await booksTab.click();
      await expect(page.locator(".source-row").first()).toBeVisible({ timeout: 30_000 });
      const books = page.locator(".book-list li");
      await books.filter({ hasText: "ביאור על בראשית" }).first().locator('button.side-btn[data-side="source"]').click();
      await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
      await page.getByRole("tab", { name: /הצעות/ }).click();
      await page.getByRole("radio", { name: "קישור מרבי" }).click();
      await page.getByRole("radio", { name: "ספרים שאבחר" }).click();
      const group = page.getByRole("group", { name: "הספרים לקישור" });
      await expect(group).toBeVisible();
      await audit(page, "book picker", group);
      // the picker with the keyboard: Space ticks a book, the count follows
      await group.getByRole("checkbox").first().focus();
      await page.keyboard.press("Space");
      await expect(group.locator(".pick-count")).toContainText("נבחרו 1");
      await group.getByRole("checkbox").first().focus();
      await page.keyboard.press("Space");
      await expect(group.getByRole("checkbox").first()).not.toBeChecked();
      // the suggestions list
      await page.getByRole("radio", { name: "שני ספרים" }).click();
      await page.getByRole("button", { name: "חיפוש התאמות" }).click();
      await expect(page.locator(".sug-table")).toBeVisible({ timeout: 30_000 });
      await audit(page, "suggestions: table", page.locator(".side-panel"));
      await page.getByRole("radio", { name: "כרטיס" }).click();
      await audit(page, "suggestions: card", page.locator(".side-panel"));
      expect(seen.errors).toEqual([]);
      expect(seen.external).toEqual([]);
    });

    test("reader: the list of headings (jump to a heading) opens inside the window, in both readers", async ({ page }) => {
      const seen = watchPage(page);
      await page.goto(distUrl);
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "קבצים", exact: true }).click();
      await (await chooser).setFiles([DB, ...Object.entries(BOOKS).map(([t, l]) => ({ name: `${t}.txt`, mimeType: "text/plain", buffer: Buffer.from(l.join(nl)) }))]);
      await expect(page.locator(".side-panel")).toBeVisible({ timeout: 30_000 });
      const booksTab = page.getByRole("tab", { name: "ספרים" });
      if (await booksTab.isVisible()) await booksTab.click();
      const books = page.locator(".book-list li");
      await books.filter({ hasText: "ביאור על בראשית" }).first().locator('button.side-btn[data-side="source"]').click();
      await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
      for (const side of ["source", "target"]) {
        const reader = page.locator(`.reader.${side}`);
        await reader.scrollIntoViewIfNeeded();
        await reader.locator("details.heading-jump > summary").click();
        const list = reader.locator(".heading-list");
        await expect(list).toBeVisible();
        const box = (await list.boundingBox())!;
        expect(box.x, `${side}: the list starts left of the window`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${side}: the list ends right of the window`).toBeLessThanOrEqual(size.width + 0.5);
        // and inside the reader's own panel, which clips what pokes out of it
        const panel = (await reader.boundingBox())!;
        expect(box.x, `${side}: clipped by its panel on the left`).toBeGreaterThanOrEqual(panel.x - 0.5);
        expect(box.x + box.width, `${side}: clipped by its panel on the right`).toBeLessThanOrEqual(panel.x + panel.width + 0.5);
        await reader.locator("details.heading-jump > summary").click();
      }
      expect(seen.errors).toEqual([]);
    });

    test("alt_toc dialog", async ({ page }) => {
      test.slow();
      const seen = watchPage(page);
      await page.goto(distUrl);
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "קבצים", exact: true }).click();
      await (await chooser).setFiles([
        { name: "חומש שלי.txt", mimeType: "text/plain", buffer: Buffer.from(ALT_BOOK) },
        { name: "חומש שלי_links.json", mimeType: "application/json", buffer: Buffer.from(ALT_LINKS) },
      ]);
      await expect(page.locator(".source-row, .reader .ln").first()).toBeVisible({ timeout: 30_000 });
      await page.getByRole("tab", { name: /קישורים/ }).first().click();
      await page.getByRole("button", { name: /^מבני כותרות/ }).click();
      const dlg = page.getByRole("dialog");
      await dlg.getByLabel("מפתח המבנה החדש (באנגלית)").fill("Parasha");
      await dlg.getByRole("button", { name: "מבנה חדש" }).click();
      await dlg.getByRole("button", { name: "מילוי מכותרות הספר" }).click();
      await expect(dlg.getByLabel("כותרת צומת 5")).toHaveValue("x");
      await audit(page, "alt_toc");
      // Escape closes it, and focus goes back to the button that opened it
      await page.keyboard.press("Escape");
      await expect(dlg).toBeHidden();
      expect(await focused(page)).toMatchObject({ tag: "button", name: expect.stringMatching(/^מבני כותרות/) });
      expect(seen.errors).toEqual([]);
      expect(seen.external).toEqual([]);
    });

    test("per-pair controls of the guided plan", async ({ page }) => {
      test.slow();
      const seen = watchPage(page);
      const dir = folder("הספרים שלי");
      // Chrome on Linux (the CI) suppresses a file chooser when the window is under 400px wide ("File chooser dialog was suppressed because the
      // top-level window size is smaller than the minimum required size"): the books are chosen in a wide window, then the window is made narrow
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(distUrl);
      await chooseTask(page, "auto", "folder-otzaria");
      const main = page.locator("main.guided");
      const next = main.locator(".guided-foot").getByRole("button", { name: /^הבא/ });
      const chooser = page.waitForEvent("filechooser");
      await main.getByRole("button", { name: "הספרים: תיקייה" }).click();
      await (await chooser).setFiles(dir);
      await expect(main.getByRole("list", { name: "נבחרו" })).toContainText("2 ספרים", { timeout: 30_000 });
      await next.click();
      await next.click();
      const dbChooser = page.waitForEvent("filechooser");
      await main.getByRole("button", { name: "מסד אוצריא: מסד נתונים" }).click();
      await (await dbChooser).setFiles([DB]);
      await expect(main.getByText("כל ספרי הבסיס נמצאו.")).toBeVisible({ timeout: 30_000 });
      await next.click();
      await expect(page).toHaveURL(/#\/guided\/plan$/);
      await page.setViewportSize({ width: size.width, height: size.height });
      const pairs = main.locator("details.guided-pairs");
      await pairs.locator("summary").click();
      await expect(pairs.locator(".pair-row").first()).toBeVisible({ timeout: 30_000 });
      await expect(pairs.locator(".pair-fit").first()).toBeVisible({ timeout: 30_000 });
      await audit(page, "guided plan: the pairs");
      expect(seen.errors).toEqual([]);
      expect(seen.external).toEqual([]);
    });
  });
}

/* keyboard only, on the new dialogs: focus is visible at every stop and never leaves the dialog; Space and Enter act; Escape closes */
test("keyboard only: the repository dialog", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 768, height: 1024 });
  const seen = watchPage(page);
  await page.goto(distUrl);
  const dlg = await openRepository(page);
  // a stop-by-stop walk: every stop shows a focus indicator, and none is behind the dialog
  const names: string[] = [];
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const f = await focused(page);
    if (!f) continue;
    names.push(f.name);
    expect(f.inDialog, `Tab ×${i + 1} reached "${f.name}" behind the dialog`).toBe(true);
    expect(f.indicator, `no visible focus on <${f.tag}> "${f.name}"`).toBe(true);
    expect(f.inViewport, `focus on "${f.name}" is out of the window`).toBe(true);
  }
  expect(names.some((n) => /ניתוח הקישורים של הספרים/.test(n))).toBe(true);
  // Enter starts the count from the keyboard
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).focus();
  await page.keyboard.press("Enter");
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  // Space ticks a book, and the dialog says so
  const box = dlg.getByRole("checkbox", { name: /^בחירה: / }).first();
  await box.focus();
  await page.keyboard.press("Space");
  await expect(box).toBeChecked();
  await expect(dlg.locator(".repo-chosen")).toContainText("נבחר ספר אחד");
  // Enter on a book's name opens its details, and focus moves there
  await dlg.locator(".repo-book").first().getByRole("button", { name: /^פרטי הספר/ }).focus();
  await page.keyboard.press("Enter");
  const detail = dlg.getByRole("region", { name: /^פרטי הספר/ });
  await expect(detail).toBeVisible();
  // Escape closes the dialog (the details are inside it) and the route leaves #/repository
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(page).not.toHaveURL(/#\/repository/);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
