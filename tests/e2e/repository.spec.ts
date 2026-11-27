import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { chooseTask, distUrl, watchPage } from "./helpers";

/*
 * V6 3.9: the repository analysis — an open database as a whole, from the "analyze and complete links in a repository" path.
 * Nothing is read until asked; the count goes book by book and can be stopped; the book list is searchable and sortable; one
 * book's details; pairs the tool suggests, chosen by the user; and "complete the links of the chosen" opens the guided flow with
 * exactly those books, running nothing.
 */
const DB_FILE = resolve("tests/fixtures/db/seforim-v7-mini.db");

test("repository: analyze a database, find the books without links, pick a suggested pair and carry it to the guided flow", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  await chooseTask(page, "repo", "analyze");
  const sheet = page.getByRole("dialog", { name: "ניתוח מאגר והשלמת קישורים" });
  const chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "המסד: מסד נתונים" }).click();
  await (await chooser).setFiles(DB_FILE);
  await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/, { timeout: 30_000 });
  await sheet.getByRole("button", { name: "התחלה" }).click();

  const dlg = page.locator("dialog.repository");
  await expect(dlg).toBeVisible();
  await expect(page).toHaveURL(/#\/repository$/);
  // nothing was read yet: the books are listed, their links are "not checked"
  const books = dlg.getByRole("list", { name: "הספרים" }).locator(".repo-book");
  await expect(books.first()).toContainText("לא נבדק");
  const stats = dlg.getByRole("group", { name: "סיכום המאגר" });
  await expect(stats).toContainText("ספרים בלי קישורים");
  await expect(stats.locator(".stat").nth(1).locator("b")).toHaveText("—");

  // the count: one book at a time, then the totals
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  await expect(stats.locator(".stat").nth(1).locator("b")).not.toHaveText("—");
  await expect(books.first()).not.toContainText("לא נבדק");
  await dlg.locator("details.repo-more summary").click();
  await expect(dlg.getByRole("list", { name: "קישורים לפי סוג" })).toBeVisible();

  // the list: search, and the books with no links
  await dlg.getByLabel("חיפוש ספר").fill("ארצות החיים");
  await expect(books.filter({ hasText: "ארצות החיים" })).not.toHaveCount(0);
  await expect(books.filter({ hasText: "6 קישורים" })).not.toHaveCount(0);
  await dlg.getByLabel("חיפוש ספר").fill("");
  await dlg.getByLabel("אילו ספרים להציג").selectOption("no-links");
  const noLinks = await books.count();
  const total = Number(((await stats.locator(".stat").nth(2).locator("b").innerText()) || "0").replace(/,/g, ""));
  expect(noLinks).toBe(total);
  if (noLinks) await expect(books.first()).toContainText("בלי קישורים");
  await dlg.getByLabel("אילו ספרים להציג").selectOption("all");
  await dlg.getByLabel("סדר הרשימה").selectOption("links-desc");
  await expect(books.first()).toContainText("קישורים");

  // one book's details: how it is linked, its coverage
  await dlg.getByLabel("חיפוש ספר").fill("ארצות החיים");
  await books.filter({ hasText: "6 קישורים" }).first().getByRole("button", { name: /^פרטי הספר/ }).click();
  const detail = dlg.getByRole("region", { name: /^פרטי הספר/ });
  await expect(detail).toContainText("6", { timeout: 30_000 });
  await expect(detail.getByRole("list", { name: "הספרים המקושרים" })).toBeVisible();
  await detail.getByRole("button", { name: /חישוב כיסוי מלא/ }).click();
  await expect(detail.getByRole("status").filter({ hasText: /שורות (ה)?תוכן/ })).toBeVisible({ timeout: 30_000 });
  await detail.getByRole("button", { name: "סגירת הפרטים" }).click();
  await dlg.getByLabel("חיפוש ספר").fill("");

  // suggested pairs: proposed, with the reasons; nothing is chosen for the user
  await expect(dlg.locator(".repo-chosen")).toContainText("עוד לא נבחרו");
  await dlg.getByRole("button", { name: "הצעת זוגות לפי השמות" }).click();
  const pair = dlg.getByRole("list", { name: "זוגות מוצעים" }).locator(".repo-pair", { hasText: "המאיר לארץ על ארצות החיים" });
  await dlg.getByLabel("גם ספרים שכבר מקושרים").check();
  await expect(pair).toBeVisible({ timeout: 30_000 });
  await expect(pair).toContainText(/ביטחון (גבוה|בינוני|נמוך)/);
  await expect(pair.locator(".repo-reasons li").first()).toBeVisible();
  await expect(dlg.getByRole("button", { name: "השלמת קישורים לנבחרים" })).toBeDisabled();
  await pair.getByRole("checkbox").check();
  await expect(dlg.locator(".repo-chosen")).toContainText("נבחר ספר אחד");

  // complete: the guided flow opens at the books it was given, and nothing ran
  await dlg.getByRole("button", { name: "השלמת קישורים לנבחרים" }).click();
  await expect(page).toHaveURL(/#\/guided\/books$/);
  const main = page.locator("main.guided");
  await expect(main).toContainText("המאיר לארץ על ארצות החיים", { timeout: 30_000 });
  await expect(main.getByRole("heading", { name: "הספרים שנמצאו" })).toBeVisible();
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

test("repository: the dialog fits a phone", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(distUrl);
  await chooseTask(page, "repo", "analyze");
  const sheet = page.getByRole("dialog", { name: "ניתוח מאגר והשלמת קישורים" });
  const chooser = page.waitForEvent("filechooser");
  await sheet.getByRole("button", { name: "המסד: מסד נתונים" }).click();
  await (await chooser).setFiles(DB_FILE);
  await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/, { timeout: 30_000 });
  await sheet.getByRole("button", { name: "התחלה" }).click();
  const dlg = page.locator("dialog.repository");
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של/)).toBeVisible({ timeout: 60_000 });
  // nothing is cut off sideways: the body does not scroll horizontally and the page does not either
  expect(await dlg.locator(".body").evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(dlg.getByRole("button", { name: "השלמת קישורים לנבחרים" })).toBeVisible();
  expect(seen.errors).toEqual([]);
});

/* the repository dialog, opened from the home path "analyze and complete links" on the small real database */
async function openRepository(page: import("@playwright/test").Page) {
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

test("repository: when the analysis finishes focus stays inside the dialog (on the summary), not on the page behind it", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const dlg = await openRepository(page);
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  const where = await page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, inDialog: !!a?.closest("dialog.repository"), status: a?.getAttribute("role") };
  });
  expect(where).toEqual({ tag: "P", inDialog: true, status: "status" });
  expect(seen.errors).toEqual([]);
});

test("repository: interactive targets are at least 24x24 CSS px (WCAG 2.5.8)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const dlg = await openRepository(page);
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  const boxes = await dlg.evaluate((root) => {
    const size = (el: Element | null) => {
      const r = el?.getBoundingClientRect();
      return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
    };
    const markShown = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("סימון המוצגים")) ?? null;
    return { checkbox: size(root.querySelector(".repo-book input[type=checkbox]")), title: size(root.querySelector(".repo-title")), markShown: size(markShown) };
  });
  for (const [name, b] of Object.entries(boxes)) {
    expect(b, name).not.toBeNull();
    expect(b!.w, `${name} width`).toBeGreaterThanOrEqual(24);
    expect(b!.h, `${name} height`).toBeGreaterThanOrEqual(24);
  }
});

test("repository: 'complete links' asks before it replaces a guided flow an earlier session left unfinished", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  // an unfinished flow, as the app's own autosave would have left it (IndexedDB "otzaria-linker", key "guided:v1")
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const record = { v: 1, step: "plan", sources: [{ label: "ספרים ישנים", kind: "text-files", books: 3 }], purpose: "submission", links: 0, done: false, savedAt: Date.now() };
        const req = indexedDB.open("otzaria-linker", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const tx = req.result.transaction("kv", "readwrite");
          tx.objectStore("kv").put(JSON.stringify(record), "guided:v1");
          tx.oncomplete = () => (req.result.close(), resolve());
          tx.onerror = () => reject(tx.error);
        };
      }),
  );
  await page.reload();
  const banner = page.locator(".recovery", { hasText: "לא הסתיים" });
  await expect(banner).toBeVisible();

  const dlg = await openRepository(page);
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  await dlg.getByRole("checkbox", { name: /^בחירה: / }).first().check();
  const complete = dlg.getByRole("button", { name: "השלמת קישורים לנבחרים" });
  await complete.click();
  // nothing was replaced yet: it asks, naming the flow it would replace, and keeps focus on the safe answer
  const ask = dlg.getByRole("alert").filter({ hasText: "תהליך מודרך שלא הסתיים" });
  await expect(ask).toContainText('שלב "התוכנית"');
  await expect(page).not.toHaveURL(/#\/guided/);
  await expect(dlg.getByRole("button", { name: /^ביטול, להשאיר/ })).toBeFocused();
  await dlg.getByRole("button", { name: /^ביטול, להשאיר/ }).click();
  await expect(ask).toHaveCount(0);
  // cancelling replaced nothing: asked again, and this time replaced
  await complete.click();
  await expect(ask).toBeVisible();
  await dlg.getByRole("button", { name: "להחליף ולהמשיך" }).click();
  await expect(page).toHaveURL(/#\/guided\/books$/);
  expect(seen.errors).toEqual([]);
});

test("repository: finger-sized targets on a coarse pointer", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "isMobile is Chromium only");
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 412, height: 915 } });
  const page = await context.newPage();
  await page.goto(distUrl);
  const dlg = await openRepository(page);
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  const small = await dlg.evaluate((root) =>
    [...root.querySelectorAll(".repo-book input[type=checkbox], .repo-title, .repo-run button, footer button")].map((el) => {
      const r = el.getBoundingClientRect();
      return { what: el.className || el.tagName, h: Math.round(r.height), w: Math.round(r.width) };
    }).filter((b) => b.h < 44),
  );
  expect(small).toEqual([]);
  await context.close();
});

test("the 'copy the folder path' button of the database hint is at least 24px high (it was 19px)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  await chooseTask(page, "repo", "analyze");
  const copy = page.getByRole("dialog").locator(".db-hint").getByRole("button", { name: /העתקה/ });
  await expect(copy).toBeVisible();
  const box = (await copy.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(24);
  expect(box.width).toBeGreaterThanOrEqual(24);
});

/*
 * Pre-merge audit: with links already made, nothing on the repository screen (analysis, stop, coverage of a book, suggested
 * pairs, picking, closing with Escape) removes or replaces them or the undo step that made them.
 */
test("repository: with links in the project, no action of the screen removes or replaces them (and Escape only closes)", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const heb = ["א", "ב", "ג", "ד", "ה"];
  const nl = String.fromCharCode(10);
  const biur = ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...heb.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])].join(nl);
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([
    { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(DB_FILE) },
    { name: "ביאור על בראשית.txt", mimeType: "text/plain", buffer: Buffer.from(biur) },
  ]);
  const books = page.getByRole("region", { name: "קבצים ומסדים" }).locator(".book-list li");
  await books.filter({ hasText: "ביאור על בראשית" }).locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: /^בראשית/ }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("button", { name: "חיפוש התאמות" }).click();
  const approveAll = page.getByRole("button", { name: /אישור כל הוודאיות/ });
  await expect(approveAll).toBeEnabled({ timeout: 30_000 });
  await approveAll.click();
  const linksTab = page.getByRole("tab", { name: /^קישורים/ });
  await expect(linksTab).toContainText("5");
  const undo = page.getByRole("button", { name: "ביטול הפעולה האחרונה" });
  await expect(undo).toBeEnabled();
  const undoTitle = await undo.getAttribute("title");

  await page.evaluate(() => (location.hash = "#/repository"));
  const dlg = page.locator("dialog.repository");
  await expect(dlg).toBeVisible();
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  await dlg.getByLabel("חיפוש ספר").fill("ארצות החיים");
  await dlg.locator(".repo-book").first().getByRole("button", { name: /^פרטי הספר/ }).click();
  const detail = dlg.getByRole("region", { name: /^פרטי הספר/ });
  await detail.getByRole("button", { name: /חישוב כיסוי מלא/ }).click();
  await expect(detail.getByRole("status").filter({ hasText: /שורות (ה)?תוכן/ })).toBeVisible({ timeout: 30_000 });
  await detail.getByRole("button", { name: "סגירת הפרטים" }).click();
  await dlg.getByRole("button", { name: "הצעת זוגות לפי השמות" }).click();
  // the books that are already linked are hidden from the proposals unless asked for (as in the first test of this file)
  await dlg.getByLabel("גם ספרים שכבר מקושרים").check();
  await expect(dlg.locator(".repo-pair").first()).toBeVisible({ timeout: 30_000 });
  await dlg.getByRole("checkbox", { name: /^בחירה: / }).first().check();
  await expect(dlg.locator(".repo-chosen")).toContainText("נבחר ספר אחד");

  // Escape closes the screen and nothing else happens
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  await expect(linksTab).toContainText("5");
  await expect(undo).toBeEnabled();
  expect(await undo.getAttribute("title")).toBe(undoTitle);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * PR 2's coverage contract on the repository screen: a book whose links were not read is "coverage unknown" (and a failed read says it
 * failed), never "no links" or "all unlinked"; a book that has none, read successfully, IS all unlinked.
 */
test("repository: a failed or missing read of a book's links is never shown as 'all unlinked'", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const dlg = await openRepository(page);
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  await dlg.getByLabel("חיפוש ספר").fill("ארצות החיים");
  await dlg.locator(".repo-book", { hasText: "6 קישורים" }).first().getByRole("button", { name: /^פרטי הספר/ }).click();
  const detail = dlg.getByRole("region", { name: /^פרטי הספר/ });
  await expect(detail).toContainText("6", { timeout: 30_000 });

  const show = (links: unknown) =>
    page.evaluate((l) => {
      const store = (globalThis as unknown as { __linker: { repository: { bookCoverage: { value: unknown }; bookCoverageBusy: { value: unknown } } } }).__linker;
      const repo = (globalThis as unknown as { __linker: { repository: { books: { value: { key: string; title: string }[] } } } }).__linker.repository;
      const book = repo.books.value.find((b) => b.title === "ארצות החיים")!;
      store.repository.bookCoverage.value = { bookKey: book.key, summary: { total: 100, byBucket: { linked: 0, unlinked: 90, partial: 0, multiple: 0, "not-suitable": 10, candidate: 0, doubtful: 0 }, suitable: 90, unlinked: 90, unlinkedShare: 1, ranges: [{ start: 3, end: 90 }], links: l } };
    }, links);

  await show({ state: "failed", message: "הדיסק נעלם" });
  const failed = detail.locator('[data-links="failed"]');
  await expect(failed).toContainText("נכשלה");
  await expect(failed).toContainText("הדיסק נעלם");
  await expect(detail).not.toContainText("90 מתוך 90");
  await expect(detail.getByRole("list", { name: "קטעים בלי קישור" })).toHaveCount(0);

  await show({ state: "unknown", why: "not-read" });
  await expect(detail.locator('[data-links="unknown"]')).toContainText("לא נקראו");
  await expect(detail.getByRole("list", { name: "קטעים בלי קישור" })).toHaveCount(0);

  // read, and the book has none: all unlinked IS the truth, and the read is said
  await show({ state: "none" });
  await expect(detail.locator("[data-links]")).toHaveCount(0);
  await expect(detail).toContainText("אין לו קישורים שם");
  await expect(detail).toContainText("90 מתוך 90 שורות תוכן בלי קישור");
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * V7 §3.14: one book's relations as a small hand-drawn map — the book and its direct neighbours only (never the repository), the
 * database's links, a suggested pair dashed; folded until asked for.
 */
test("repository: the map of one book's direct relations, with a suggested pair", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const dlg = await openRepository(page);
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  await dlg.getByRole("button", { name: "הצעת זוגות לפי השמות" }).click();
  await expect(dlg.getByText(/זוגות הוצעו מתוך/)).toBeVisible();
  await dlg.getByLabel("חיפוש ספר").fill("ארצות החיים");
  await dlg.locator(".repo-book", { hasText: "6 קישורים" }).first().getByRole("button", { name: /^פרטי הספר/ }).click();
  const detail = dlg.getByRole("region", { name: /^פרטי הספר/ });
  await expect(detail).toContainText("6", { timeout: 30_000 });
  await expect(detail.locator(".repo-map svg")).toHaveCount(0);
  await detail.getByText("מפת הקשרים של הספר").click();
  const map = detail.getByRole("img", { name: /^ארצות החיים ו/ });
  await expect(map).toBeVisible();
  const nodes = await map.locator("g").count();
  expect(nodes).toBeGreaterThan(0);
  expect(nodes).toBeLessThanOrEqual(8);
  await expect(map.locator("g.repo-map-sug title", { hasText: "המאיר לארץ על ארצות החיים:" })).toContainText("מוצע כמפרש שלו");
  await expect(map.locator("line[marker-end]")).not.toHaveCount(0);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * V7 §3.13: the source is named; a book whose links could not be read is counted apart and is "unknown", never first among the
 * books with fewest links; the list filters the partly linked and the unread ones and sorts by problems; the analysis is saved as a
 * report, where an unread book has empty counts, not zeros.
 */
test("repository: the source is named, an unread book is unknown (not 0) in the list, the stats and the saved report", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const dlg = await openRepository(page);
  await expect(dlg).toContainText("המסד: seforim-v7-mini.db");
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  // one book's read fails (as a database whose link table is damaged would): the row the analysis writes for it
  const unread = await page.evaluate(() => {
    const repo = (globalThis as unknown as { __linker: { repository: { rows: { value: Map<string, { title: string; total: number; unavailable?: string }> } } } }).__linker.repository;
    const rows = new Map(repo.rows.value);
    const [key, row] = [...rows].find(([, r]) => r.total > 0)!;
    rows.set(key, { ...row, total: 0, out: 0, in: 0, top: [], flags: [], unavailable: "קריאת הקישורים נכשלה: הדיסק נעלם" } as typeof row);
    repo.rows.value = rows;
    return row.title;
  });
  const stats = dlg.getByRole("group", { name: "סיכום המאגר" });
  await expect(stats).toContainText("ספרים שהקישורים שלהם לא נקראו");
  const books = dlg.getByRole("list", { name: "הספרים" }).locator(".repo-book");
  await dlg.getByLabel("סדר הרשימה").selectOption("links-asc");
  await expect(books.first()).not.toContainText(unread);
  await dlg.getByLabel("אילו ספרים להציג").selectOption("unreadable");
  await expect(books).toHaveCount(1);
  await expect(books.first()).toContainText(unread);
  await expect(books.first()).toContainText("אי אפשר לקרוא");
  await dlg.getByLabel("אילו ספרים להציג").selectOption("partial");
  await dlg.getByLabel("סדר הרשימה").selectOption("problems");

  const download = page.waitForEvent("download");
  await dlg.getByRole("button", { name: "שמירת דוח" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^ניתוח-מאגר-\d{4}-\d\d-\d\d\.csv$/);
  const rows = readFileSync((await file.path())!, "utf8").replace(/^﻿/, "").split("\r\n");
  expect(rows[0]).toContain('"ספר","שורות","קישורים"');
  const line = rows.find((r) => r.includes(`"${unread}"`))!;
  expect(line).toContain('"לא נקרא: קריאת הקישורים נכשלה: הדיסק נעלם"');
  expect(line).not.toMatch(/"0"/);
  expect(rows.length).toBe(Number((await stats.locator(".stat").first().locator("b").innerText()).replace(/,/g, "")) + 1);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});


/*
 * V7 §3.14, accessible and useful: the map has a text alternative — a list of the same neighbours with what ties each to the
 * book — that a screen reader is pointed to, and the keyboard's way through the map: a neighbour in the same database opens
 * its own details.
 */
test("repository: the relation map in words, by keyboard, and a neighbour's details from it", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(distUrl);
  const dlg = await openRepository(page);
  await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
  await expect(dlg.getByText(/נקראו הקישורים של כל [\d,]+ הספרים/)).toBeVisible({ timeout: 60_000 });
  await dlg.getByRole("button", { name: "הצעת זוגות לפי השמות" }).click();
  await expect(dlg.getByText(/זוגות הוצעו מתוך/)).toBeVisible();
  await dlg.getByLabel("חיפוש ספר").fill("ארצות החיים");
  await dlg.locator(".repo-book", { hasText: "6 קישורים" }).first().getByRole("button", { name: /^פרטי הספר/ }).click();
  const detail = dlg.getByRole("region", { name: /^פרטי הספר ארצות החיים/ });
  await expect(detail).toContainText("6", { timeout: 30_000 });
  // opened from the keyboard
  await detail.getByText("מפת הקשרים של הספר").focus();
  await page.keyboard.press("Enter");
  const map = detail.getByRole("img", { name: /^ארצות החיים ו/ });
  await expect(map).toBeVisible();
  const list = detail.getByRole("list", { name: "הספרים שבמפה" });
  // the same neighbours as the drawing, each in words; the drawing points to the list
  await expect(list.getByRole("listitem")).toHaveCount(await map.locator("g").count());
  expect(await map.getAttribute("aria-describedby")).toBe(await list.getAttribute("id"));
  await expect(list.getByRole("listitem").filter({ hasText: "המאיר לארץ על ארצות החיים" })).toContainText("מוצע כמפרש שלו");
  const go = list.getByRole("button", { name: "מעבר לפרטי הספר המאיר לארץ על ארצות החיים" });
  await go.focus();
  await page.keyboard.press("Enter");
  await expect(dlg.getByRole("region", { name: /^פרטי הספר המאיר לארץ על ארצות החיים/ })).toBeVisible();
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
