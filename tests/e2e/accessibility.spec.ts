import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { clippedControls, focused, horizontalOverflow, lowContrast, tabTo, unnamedControls } from "./a11y";
import { distUrl, watchPage } from "./helpers";

/*
 * Accessibility regressions (docs/reviews/ACCESSIBILITY_AUDIT.md), in the built single file: the
 * guided flow and the workspace with the keyboard only, dialogs and menus that keep focus and give it
 * back, a name for every control on each main screen, AA contrast in both themes, the task's progress
 * in a live region, and 200% zoom at 1280px (a 640px-wide window) without sideways scrolling or a
 * control out of reach. No axe: the checks are tests/e2e/a11y.ts, on Playwright's ARIA snapshots.
 */
const nl = String.fromCharCode(10);
const HEB = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
const DB = { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) };
const commentary = (t: string) => [`<h1>${t}</h1>`, "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `${t}: ביאור לפסוק ${i + 1}`])];
const BOOKS: Record<string, string[]> = {
  "ביאור על בראשית": commentary("ביאור על בראשית"),
  "ספר דוגמה": ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה עם הערה (1) ועוד אחת (2).", "<h2>פרק ב</h2>", "כאן המספור מתחיל שוב (1)."],
  "הערות לספר דוגמה": ["<h1>הערות לספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה בפרק א.", "(2) הערה שנייה בפרק א.", "<h2>פרק ב</h2>", "(1) הערה ראשונה בפרק ב."],
};
const COMMENTARY_FILE = { name: "ביאור על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(BOOKS["ביאור על בראשית"]!.join(nl)) };

function folder(name: string): string {
  const dir = join(test.info().outputPath(), name);
  mkdirSync(dir, { recursive: true });
  for (const [title, lines] of Object.entries(BOOKS)) writeFileSync(join(dir, `${title}.txt`), lines.join(nl), "utf8");
  return dir;
}

/**
 * Waits until nothing finite is animating for `quietMs` (at most 6 s): a shown line flashes (1.2 s from
 * the highlight colour) and the flash starts some frames after the click that showed it (the card
 * mounts, then each reader loads its line, then a frame; the two readers' flashes began 40 ms apart in
 * Firefox) — a single look at getAnimations() right after the click could miss one of them, and the
 * dark theme was then measured mid-flash (CI: 3.7–4.4:1 on a line number, chrome, edge and firefox).
 * Measure the colours it settles on. Endless animations (a spinner) are not waited for.
 */
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

/** No control without a name, and no text under AA contrast, in the light and the dark theme. */
async function screenOk(page: Page, what: string) {
  const body = page.locator("body");
  await settled(page, 400);
  expect(await unnamedControls(body), `${what}: controls without a name`).toEqual([]);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    // (a theme change can start a transition, e.g. a switch's background)
    await settled(page, 50);
    expect(await lowContrast(body), `${what} (${theme}): text under AA contrast`).toEqual([]);
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
}

/** Opens the workspace with the Otzaria database and a commentary on Bereshit, the commentary as source. */
async function workspace(page: Page) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([DB, COMMENTARY_FILE]);
  // (a narrow window keeps the sources list in a tab: wait for the first book shown instead)
  await expect(page.locator(".reader.source .ln").first()).toBeVisible({ timeout: 30_000 });
}

test("keyboard only: the guided flow from the home card to the download", async ({ page }) => {
  // a long walk by Tab; ~50 s alone, more beside other workers — triple the default rather than flake
  test.slow();
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  const dir = folder("הספרים שלי");
  await page.goto(distUrl);
  const main = page.locator("main.guided");

  // every Tab stop on the way shows where focus is (tabTo checks it)
  await tabTo(page, /^תיקייה מול אוצריא/);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/guided\/files$/);
  await tabTo(page, /^הספרים: תיקייה$/);
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles(dir);
  await expect(main.getByRole("list", { name: "נבחרו" })).toContainText("3 ספרים", { timeout: 30_000 });

  // "הבא" moves to the next step and focus to its heading, so the step is announced
  await tabTo(page, /^הבא: הספרים שנמצאו$/);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/guided\/books$/);
  expect((await focused(page))?.name).toBe("הספרים שנמצאו");
  await tabTo(page, /^הבא: מסד אוצריא$/);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/guided\/db$/);
  await tabTo(page, /^מסד אוצריא: מסד נתונים$/);
  const db = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await db).setFiles([DB]);
  await expect(main.getByText("כל ספרי הבסיס נמצאו.")).toBeVisible({ timeout: 30_000 });
  await tabTo(page, /^הבא: התוכנית$/);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/guided\/plan$/);

  // the purpose is a radio group: arrows change it, Tab leaves it
  await tabTo(page, /^הפעלה$/);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/guided\/run$/);
  await expect(main.getByRole("button", { name: /^אישור כל [\d,]+ הוודאיות$/ })).toBeVisible({ timeout: 30_000 });
  await tabTo(page, /^אישור כל [\d,]+ הוודאיות$/);
  await page.keyboard.press("Enter");
  await expect(main.getByRole("button", { name: "כל הוודאיות אושרו" })).toBeDisabled();
  await tabTo(page, /^הבא: בדיקה והורדה$/);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#\/guided\/finish$/);

  const download = main.getByRole("button", { name: /^הורדת/ });
  await expect(download).toBeEnabled({ timeout: 30_000 });
  await tabTo(page, /^הורדת/);
  const dl = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  expect((await dl).suggestedFilename()).toMatch(/\.zip$/);
  // the button gave way to "what now?": focus is on what happened, not on the top of the page
  expect((await focused(page))?.name).toMatch(/ירד|הורד/);
  expect(seen.errors).toEqual([]);
});

test("keyboard only: pick lines and link them, approve and reject suggestions, export", async ({ page }) => {
  // a long walk by Tab; ~50 s alone, more beside other workers — triple the default rather than flake
  test.slow();
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(distUrl);
  await tabTo(page, /^קבצים$/);
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles([DB, COMMENTARY_FILE]);
  await expect(page.locator(".source-row")).toHaveCount(2, { timeout: 30_000 });
  // focus starts at the workspace, not at the top of the page
  expect((await focused(page))?.name).toBe("סביבת העבודה");

  // the book buttons say which book
  await tabTo(page, /^מקור: ביאור על בראשית$/);
  await page.keyboard.press("Enter");
  await tabTo(page, /^יעד: בראשית$/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".reader.target .panel-head h2")).toHaveText("בראשית");
  // the arrows pick lines; the picked line is said in the reader's live region
  await tabTo(page, /^שורות ספר המקור/);
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowDown");
  await expect(page.locator(".reader.source [role=status]")).toContainText(/^נבחרה שורה \d+: /);
  await tabTo(page, /^שורות ספר היעד/);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".reader.source .mark.new")).toHaveCount(1);

  // the side panel's tabs: one Tab stop, arrows between them (the row runs right to left)
  await tabTo(page, /^בונה$/);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await focused(page)).toMatchObject({ role: "tab", name: "הצעות" });
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "side-tab-suggestions");
  await tabTo(page, /^חיפוש התאמות$/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".sug-table")).toBeVisible({ timeout: 30_000 });
  // the form gave way to the results: focus stays in the panel
  expect(await page.evaluate(() => !!document.activeElement?.closest("#side-tabpanel"))).toBe(true);

  // a decided row leaves the "pending" list; focus goes on to the next row's button
  await tabTo(page, /^אישור ההצעה לשורה/);
  const first = (await focused(page))!.name;
  await page.keyboard.press("Enter");
  await expect(page.locator(".sug-head")).toContainText("1 אושרו");
  const next = (await focused(page))!.name;
  expect(next).toMatch(/^אישור ההצעה לשורה/);
  expect(next).not.toBe(first);
  await page.keyboard.press("Shift+Tab"); // the row itself, then its checkbox; the reject button is after approve
  await tabTo(page, /^דחיית ההצעה לשורה/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".sug-head")).toContainText("1 אושרו");
  await expect(page.locator(".sug-head")).toContainText(/\d+ ממתינות/);
  expect((await focused(page))?.name).toMatch(/^דחיית ההצעה לשורה/);

  // the links list (the tab before, with the arrow): a row shows its two ends with Enter
  // the tab itself: Firefox also stops on the scrollable tabpanel, which is named after it
  await tabTo(page, /^הצעות/, { back: true, max: 120, role: "tab" });
  await page.keyboard.press("ArrowRight");
  expect(await focused(page)).toMatchObject({ role: "tab", name: expect.stringMatching(/^קישורים \d+$/) });
  // the row, not the list around it: in Firefox the scrolled list is a Tab stop too, and its text starts with the first row's
  await tabTo(page, /^חדש ביאור על בראשית/, { tag: "li" });
  await page.keyboard.press("Enter");
  // both ends stay marked (the flash is 1.2 s and can end before a loaded browser is asked)
  await expect(page.locator(".reader.target .ln.picked")).toHaveCount(1);
  await expect(page.locator(".reader.source .ln.picked")).toHaveCount(1);

  await tabTo(page, /^ייצוא/, { back: true, max: 120 });
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "ייצוא קובצי קישורים" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^הורדת (הקובץ|ZIP)/ })).toBeEnabled({ timeout: 15_000 });
  await tabTo(page, /^הורדת (הקובץ|ZIP)$/, { max: 40 });
  const dl = page.waitForEvent("download");
  await page.keyboard.press("Enter");
  await dl;
  expect(await focused(page)).toMatchObject({ inDialog: true });
  expect((await focused(page))?.name).toMatch(/ירד/);
});

test("dialogs and menus keep focus inside, close with Esc and give focus back", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(distUrl);

  /** Tab and Shift+Tab many times: focus never reaches the page behind (the browser's own UI is allowed) */
  const trapped = async () => {
    for (const key of ["Tab", "Shift+Tab"])
      for (let i = 0; i < 35; i++) {
        await page.keyboard.press(key);
        const f = await focused(page);
        if (f) expect(f.inDialog, `${key} ×${i + 1} reached "${f.name}" behind the dialog`).toBe(true);
      }
  };

  // a task's sheet, opened from its card
  const card = await tabTo(page, /^ספר ופירוש/);
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "ספר ופירוש" });
  await expect(sheet).toBeVisible();
  expect(await focused(page)).toMatchObject({ inDialog: true });
  await trapped();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  expect((await focused(page))?.name).toBe(card.name);

  // help, with F1, back to where focus was
  await page.keyboard.press("F1");
  const help = page.getByRole("dialog", { name: /עזרה/ });
  await expect(help).toBeVisible();
  await trapped();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  expect((await focused(page))?.name).toBe(card.name);

  // the settings menu: focus to its first item, arrows inside, Esc back to the button, Tab closes and moves on
  const settings = page.getByRole("button", { name: "הגדרות", exact: true });
  await settings.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "הגדרות" });
  await expect(menu).toBeVisible();
  expect(await focused(page)).toMatchObject({ role: "menuitemradio", name: "לפי המערכת" });
  await expect(menu.getByRole("group", { name: "ערכת צבעים" })).toBeVisible();
  await page.keyboard.press("End");
  expect((await focused(page))?.role).toBe("menuitem");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  expect((await focused(page))?.name).toBe("הגדרות");
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(menu).toBeHidden();
  expect((await focused(page))?.name).not.toBe("הגדרות");
});

test("every control has a name, and text has AA contrast, on each main screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(distUrl);
  await screenOk(page, "home");
  await page.getByRole("button", { name: "הגדרות", exact: true }).click();
  await screenOk(page, "settings menu");
  await page.keyboard.press("Escape");

  await page.locator(".task-card", { hasText: "תיקייה מול אוצריא" }).click();
  await screenOk(page, "guided: files");
  await page.goto(distUrl);

  await workspace(page);
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: "ביאור על בראשית" }).getByRole("button", { name: "מקור" }).click();
  await books.filter({ hasText: /^בראשית/ }).first().getByRole("button", { name: "יעד" }).click();
  await page.locator('.reader.source .ln[data-i="3"] .tx').click();
  await page.locator('.reader.target .ln[data-i="2"] .tx').click();
  await screenOk(page, "workspace: builder");
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await expect(page.locator(".sug-table")).toBeVisible({ timeout: 30_000 });
  await page.locator(".sug-table tbody tr").first().getByRole("button", { name: /^דחיית/ }).click(); // a faded row
  await page.locator(".sug-table tbody tr").first().getByRole("button", { name: /^אישור ההצעה/ }).click(); // a link to check
  await page.getByRole("button", { name: "הכול", exact: true }).click(); // every state, the faded rows too
  await screenOk(page, "workspace: suggestions table");
  await page.getByRole("radio", { name: "כרטיס" }).click();
  await screenOk(page, "workspace: suggestions card");
  await page.getByRole("tab", { name: /^קישורים/ }).click();
  await screenOk(page, "workspace: links");
  await page.getByRole("tab", { name: "קישורים מהמסד" }).click();
  await screenOk(page, "workspace: database links");
  await page.getByRole("tab", { name: /בדיקה/ }).click();
  await page.getByRole("button", { name: "בדיקת הקישורים" }).click();
  await expect(page.getByText(/קישורים נבדקו/)).toBeVisible();
  await screenOk(page, "workspace: check");
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("button", { name: "הרצה חדשה" }).click();
  await page.getByRole("radio", { name: "קישור מרבי" }).click();
  await screenOk(page, "max-link");
  await page.getByRole("button", { name: /^ייצוא/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: /^הורדת (הקובץ|ZIP)/ })).toBeEnabled({ timeout: 15_000 });
  await screenOk(page, "export dialog");
  await page.keyboard.press("Escape");
  await page.keyboard.press("F1");
  await expect(page.getByRole("dialog")).toBeVisible();
  await screenOk(page, "help");
  await page.keyboard.press("Escape");

  // the mapping wizard, for a database in someone else's schema
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "הוספת מקור" }).click();
  await page.locator(".add-options").getByRole("button", { name: /^מסד נתונים/ }).click();
  await (await chooser).setFiles([{ name: "corpus.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/generic/books-lines.db")) }]);
  const wizard = page.getByRole("dialog", { name: /איך לקרוא את המסד/ });
  await expect(wizard).toBeVisible({ timeout: 15_000 });
  await wizard.getByRole("button", { name: "שינוי המיפוי" }).click();
  await wizard.locator(".map-why summary").click(); // the reasons and the verdict badges
  await wizard.getByRole("button", { name: "בדיקת המיפוי" }).click();
  await expect(wizard.getByRole("status", { name: "תוצאת בדיקת המיפוי" })).toBeVisible();
  await screenOk(page, "mapping wizard");
});

test("a task's progress is said through a live region that was on the page before it started", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(distUrl);
  await workspace(page);
  const books = page.getByRole("region", { name: "מקורות וספרים" }).locator(".book-list li");
  await books.filter({ hasText: "ביאור על בראשית" }).getByRole("button", { name: "מקור" }).click();
  await books.filter({ hasText: /^בראשית/ }).first().getByRole("button", { name: "יעד" }).click();
  await page.getByRole("tab", { name: /הצעות/ }).click();

  // the region is there, empty, before the task; what it says while the task runs is recorded
  const region = page.locator('[data-live="task"]');
  await expect(region).toHaveAttribute("role", "status");
  await expect(region).toHaveText("");
  await region.evaluate((el) => {
    const said: string[] = [];
    (window as unknown as { __said: string[] }).__said = said;
    new MutationObserver(() => el.textContent && said.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  await expect(page.locator(".sug-table")).toBeVisible({ timeout: 30_000 });
  const said = await page.evaluate(() => (window as unknown as { __said: string[] }).__said);
  expect(said.length).toBeGreaterThan(0);
  expect(said[0]).toMatch(/\S/);
  // the visible progress in the app bar is not a second live region (it was re-read at every step)
  expect(await page.locator(".app-bar .task[role=status], .app-bar .task[aria-live]").count()).toBe(0);
});

test("200% zoom at 1280px: no sideways scrolling and every control reachable", async ({ page }) => {
  // 200% of a 1280×860 window is a 640×430 viewport in CSS pixels
  await page.setViewportSize({ width: 640, height: 430 });
  await page.goto(distUrl);
  const check = async (what: string) => {
    expect(await horizontalOverflow(page), `${what}: the page scrolls sideways`).toBeLessThanOrEqual(0);
    expect(await clippedControls(page), `${what}: controls out of reach`).toEqual([]);
  };
  await check("home");
  await page.locator(".task-card", { hasText: "תיקייה מול אוצריא" }).click();
  await check("guided: files");
  await page.goto(distUrl);
  await workspace(page);
  await check("workspace");
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await check("workspace: suggestions");
  await page.getByRole("button", { name: "הגדרות", exact: true }).click();
  await check("settings menu");
  await page.keyboard.press("Escape");
  await page.keyboard.press("F1");
  await expect(page.getByRole("dialog")).toBeVisible();
  await check("help");
});
