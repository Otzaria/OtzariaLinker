import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { chooseTask, distUrl, watchPage } from "../e2e/helpers";
import { embedFonts, fontLeaks, fontsSettled } from "./stable";

/*
 * Visual regression of the screens and dialogs (docs/TESTING.md §2a): every test runs at 1280, 768 and
 * 390 px, and each shot is compared in light and in dark. Each test reaches its screen the way the E2E
 * specs do, with the real database slice, the wizard's fixture databases and small text books, then
 * compares the viewport with the baseline. The fonts are embedded and checked (stable.ts). Nothing on
 * these screens depends on the clock; durations appear only in the advanced max-link report and are
 * masked anyway (`timeMasks`). Notices are cleared before each shot, except the errors of the notices
 * test (`snap`).
 */
const DB = { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) };
const nl = String.fromCharCode(10);
const txt = (name: string, lines: string[]) => ({ name, mimeType: "text/plain", buffer: Buffer.from(lines.join(nl), "utf8") });
const HEB = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
const BIUR = txt("ביאור על בראשית.txt", ["<h1>ביאור על בראשית</h1>", "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור לפסוק ${i + 1}`])]);

const SAMPLE = txt("ספר דוגמה.txt", ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה עם הערה (1) ועוד אחת (2).", "<h2>פרק ב</h2>", "כאן המספור מתחיל שוב (1)."]);
const SAMPLE_NOTES = txt("הערות לספר דוגמה.txt", ["<h1>הערות לספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה בפרק א.", "(2) הערה שנייה בפרק א.", "<h2>פרק ב</h2>", "(1) הערה ראשונה בפרק ב."]);

/**
 * The widths. The layout is chosen at load from the window's width (under 1200 px the sources list
 * moves into the side panel, under 900 px everything is one column), so the width is set before the
 * page opens, per describe block — not by resizing a page that is already open.
 */
const WIDTHS = [
  ["desktop", { width: 1280, height: 800 }],
  ["tablet", { width: 768, height: 1024 }],
  ["phone", { width: 390, height: 844 }],
] as const;

let seen: ReturnType<typeof watchPage>;

test.beforeEach(async ({ page }) => {
  seen = watchPage(page);
  await embedFonts(page);
  await page.goto(distUrl);
  await expect(page.getByRole("heading", { name: "מה תרצו לעשות?" })).toBeVisible();
  await fontsSettled(page);
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
  await books.filter({ hasText: source }).first().locator('button.side-btn[data-side="source"]').click();
  await books.filter({ hasText: target }).first().locator('button.side-btn[data-side="target"]').click();
  await page.getByRole("tab", { name: "בונה" }).click();
}

/** Anything that shows a time or a duration. */
const timeMasks = (page: Page): Locator[] => [page.locator("summary", { hasText: "שניות" }), page.locator(".ml-steps"), page.locator(".cov-time"), page.locator(".repo-time")];

async function snap(page: Page, name: string, { keepErrors = false } = {}) {
  // success/info notices fade by themselves after 5 s, so whether one is still there depends on how
  // long the run took; they are cleared rather than compared. Errors stay until closed: `keepErrors`
  // compares them.
  const left = await page.evaluate((keep) => {
    const notices = (globalThis as unknown as { __linker: { notices: { value: { kind: string }[] } } }).__linker.notices;
    notices.value = keep ? notices.value.filter((n) => n.kind === "error") : [];
    return notices.value.length;
  }, keepErrors);
  if (!left) await expect(page.locator(".notices .notice")).toHaveCount(0);
  // where the side panel, and under 900 px the whole workspace (one scrolling column), end up
  // scrolled depends on when content grew relative to the last click's scroll-into-view (the max-link
  // report, the suggestions table): always show their top
  await page.evaluate(() => document.querySelectorAll(".workspace, .side-panel .panel-body").forEach((e) => (e.scrollTop = 0)));
  await page.mouse.move(0, 0); // no hover state left on the last clicked control
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
  await fontsSettled(page);
  // text in a system font would draw differently on the next machine (stable.ts)
  expect(await fontLeaks(page), "text drawn by a system font").toEqual([]);
  const width = WIDTHS.find(([, v]) => v.width === page.viewportSize()?.width)![0];
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
    await expect(page).toHaveScreenshot([width, `${name}-${colorScheme}.png`], { mask: timeMasks(page) });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** Advanced mode, as the top bar's switch does it (on a phone the switch is in a menu). */
async function setAdvanced(page: Page) {
  await page.evaluate(() => ((globalThis as unknown as { __linker: { prefs: { advanced: { value: boolean } } } }).__linker.prefs.advanced.value = true));
  await expect(page.locator("html")).toHaveAttribute("data-theme", /light|dark/);
}

async function dropDatabase(page: Page, name: string, fixture: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "קבצים", exact: true }).click();
  await (await chooser).setFiles([{ name, mimeType: "application/octet-stream", buffer: readFileSync(resolve(fixture)) }]);
  const wizard = page.getByRole("dialog", { name: /איך לקרוא את המסד/ });
  await expect(wizard).toBeVisible({ timeout: 15_000 });
  return wizard;
}

for (const [width, viewport] of WIDTHS) {
  test.describe(width, () => {
    test.use({ viewport });

    test("home: task cards and the drop strip", async ({ page }) => {
      await snap(page, "home");
    });

    test("start: a guided workflow asks for its sources step by step", async ({ page }) => {
      // the card now starts the guided flow (#/guided); the sheet is still the route "#/start/<id>"
      await page.goto(`${distUrl}#/start/folder-otzaria`);
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

    test("max-link: the job panel with a book that failed, and the report", async ({ page }) => {
      await openFiles(page, [BIUR, SAMPLE, SAMPLE_NOTES]);
      // one book cannot be read in this session, the way tests/e2e/maxlink-job.spec.ts makes it fail
      await page.evaluate((title) => {
        type Svc = { runMaxLink(steps: { source: { title: string } }[], o: unknown, opts: unknown): Promise<unknown> };
        const svc = (globalThis as unknown as { __linker: { maxLink: { service: Svc } } }).__linker.maxLink.service;
        const run = svc.runMaxLink.bind(svc);
        svc.runMaxLink = (steps, o, opts) =>
          steps[0]!.source.title === title ? Promise.reject(Object.assign(new Error(`אי אפשר לקרוא את הקובץ "${title}.txt": ייתכן שהוא השתנה או נמחק אחרי שנבחר. בחרו את התיקייה או הקבצים שוב.`), { code: "text/unreadable" })) : run(steps, o, opts);
      }, "הערות לספר דוגמה");
      await page.getByRole("tab", { name: /הצעות/ }).click();
      await page.getByRole("radio", { name: "קישור מרבי" }).click();
      await expect(page.getByRole("status").filter({ hasText: "ספרים נבחרו" })).toContainText("7 הרצות");
      await page.getByRole("button", { name: "הפעלת קישור מרבי" }).click();
      // a failed book: the job card comes forward by itself; the report opens on request (V5 UX audit U15)
      await expect(page.getByRole("region", { name: "עבודת הקישור המרבי" })).toContainText("שנכשלו", { timeout: 30_000 });
      await page.getByRole("button", { name: /^דוח העבודה/ }).click();
      await expect(page.locator("details.ml-report")).toBeVisible();
      await expect(page.getByRole("button", { name: /אישור כל הוודאיות/ })).toBeEnabled();
      await snap(page, "maxlink-report");
    });

    test("loaded: fifty suggestions with notes for a book with a long Hebrew title", async ({ page }) => {
      const title = "ביאור ארוך ומפורט מאוד על ספר בראשית לפי סדר הפרקים והפסוקים";
      const lines = [`<h1>${title}</h1>`, ...HEB.flatMap((p, c) => [`<h2>פרק ${p}</h2>`, ...HEB.flatMap((v, i) => [`<h3>פסוק ${v}</h3>`, `פירוש לפרק ${c + 1} פסוק ${i + 1}: דברי המפרש על המקרא הזה, בלשון ארוכה שאינה נכנסת בשורה אחת של הטבלה.`])])];
      await openFiles(page, [txt(`${title}.txt`, lines)]);
      await pickBooks(page, "ביאור ארוך ומפורט", /^בראשית/);
      await page.getByRole("tab", { name: /הצעות/ }).click();
      await page.getByRole("button", { name: "חיפוש התאמות" }).click();
      // the slice of the database holds part of Genesis: 50 of the 100 verses, "possible" or "ambiguous"
      await expect(page.locator(".side-panel")).toContainText("50 הצעות · 50 ממתינות", { timeout: 30_000 });
      await snap(page, "suggestions-loaded");
    });

    test("notices: errors stay, the newest on one line and a fold for the rest", async ({ page }) => {
      const chooser = page.waitForEvent("filechooser");
      await page.locator(".drop-strip").getByRole("button", { name: "קבצים", exact: true }).click();
      // five broken links files: five error notices (tests/e2e/robustness.spec.ts)
      await (await chooser).setFiles(["א", "ב", "ג", "ד", "ה"].map((t) => ({ name: `${t}_links.json`, mimeType: "application/json", buffer: Buffer.from(`[{"line_index_1": 1, "path_2": "x.txt"`) })));
      await expect(page.locator(".notice.error")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "עוד 4 הודעות · כולן שגיאות" })).toBeVisible();
      await snap(page, "notices-errors", { keepErrors: true });
    });

    test("mapping wizard: the explained guess for a database in another schema", async ({ page }) => {
      const wizard = await dropDatabase(page, "corpus.db", "tests/fixtures/db/generic/books-lines.db");
      await expect(wizard.locator(".map-summary")).toContainText('ספרים מ"works"');
      await expect(wizard.locator(".map-sample th.mapped")).toHaveCount(4);
      await snap(page, "db-wizard");
    });

    test("mapping wizard: a database with no books says so, with the reasons", async ({ page }) => {
      const wizard = await dropDatabase(page, "app.db", "tests/fixtures/db/wizard/settings-log.db");
      await expect(wizard.locator(".map-nobooks")).toContainText("לא נמצאו ספרים במסד הזה.");
      await expect(wizard.locator(".map-why")).toContainText("ערכים חוזרים");
      await snap(page, "db-wizard-no-books");
    });

    test("compare and merge: the database against two versions of a links file, then the links table", async ({ page }) => {
      // the data of tests/e2e/links-compare.spec.ts: the library's record of link 13469515 and the book's other database rows
      const MEIR = "המאיר לארץ על ארצות החיים";
      const YEHUDA = "ארץ יהודה על ארצות החיים";
      const LIB_1 = { line_index_1: 323, heRef_2: 'המאיר לארץ על ארצות החיים, סימן יא, סעיף ד ס"ק יח', path_2: `${MEIR}.txt`, line_index_2: 1307, start: 33, "Conection Type": "commentary" };
      const rec = (s: number, title: string, t: number, end?: number) => ({ line_index_1: s, heRef_2: `${title} ${t}`, path_2: `${title}.txt`, line_index_2: t, ...(end && { line_index_2_end: end }), "Conection Type": "commentary" });
      const ROWS = [rec(333, YEHUDA, 314, 317), rec(397, YEHUDA, 450, 455), rec(425, MEIR, 1979), rec(613, YEHUDA, 672, 711), rec(613, MEIR, 2663)];
      const V1 = JSON.stringify([LIB_1, ...ROWS], null, 2);
      const V2 = JSON.stringify([LIB_1, ROWS[0], rec(397, YEHUDA, 450, 460), rec(425, MEIR, 1980), ROWS[3], rec(500, MEIR, 2000)], null, 2);
      const NAME = "ארצות החיים_links.json";
      await openFiles(page, []);
      await page.locator(".book-list li").filter({ hasText: /^ארצות החיים/ }).locator('button.side-btn[data-side="source"]').click();
      await page.getByRole("tab", { name: /קישורים/ }).first().click();
      await page.getByRole("button", { name: "השוואה ומיזוג" }).click();
      const dlg = page.getByRole("dialog");
      for (const text of [V1, V2]) {
        const chooser = page.waitForEvent("filechooser");
        await dlg.getByRole("button", { name: /הוספת קובצי/ }).click();
        await (await chooser).setFiles([{ name: NAME, mimeType: "application/json", buffer: Buffer.from(text) }]);
      }
      await expect(dlg.getByLabel("הספר")).toHaveValue("ארצות החיים");
      await dlg.getByRole("button", { name: "קריאת הקישורים מהמסד" }).click();
      await expect(dlg.locator(".cmp-sets").first()).toContainText("המסד 6 קישורים");
      await dlg.getByLabel("לפני (א)").selectOption({ label: "המסד" });
      await dlg.getByLabel("אחרי (ב)").selectOption({ label: `⁦${NAME} (2)⁩` });
      await dlg.getByRole("button", { name: "השוואה", exact: true }).click();
      await expect(dlg.locator(".cmp-diff .chip")).toHaveCount(5);
      await expect(dlg.locator(".cmp-merge .stat b")).toHaveText(["6", "1", "3", "2"]);
      await snap(page, "compare-dialog");

      await dlg.locator(".cmp-merge").getByRole("button", { name: "מיזוג לפרויקט" }).click();
      await expect(page.getByText(/המיזוג הוחל/)).toBeVisible();
      await dlg.getByRole("button", { name: "סגירה" }).click();
      await expect(page.locator(".vlist .link-item")).toHaveCount(7);
      await page.locator(".lt-head input[type=checkbox]").check();
      await expect(page.getByRole("toolbar", { name: "פעולות על הנבחרים" })).toBeVisible();
      await snap(page, "links-table");
    });

    test("guided flow: the books found in a folder, by group", async ({ page }) => {
      const dir = join(test.info().outputPath(), "הספרים שלי");
      mkdirSync(dir, { recursive: true });
      const commentary = (t: string) => [`<h1>${t}</h1>`, "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `${t}: ביאור לפסוק ${i + 1}`])];
      const books: Record<string, string[]> = {
        "ביאור על בראשית": commentary("ביאור על בראשית"),
        "ביאור קצר על בראשית": commentary("ביאור קצר על בראשית"),
        "ספר דוגמה": SAMPLE.buffer.toString("utf8").split(nl),
        "הערות לספר דוגמה": SAMPLE_NOTES.buffer.toString("utf8").split(nl),
        "חידושים": ["שורה אחת של חידושים."],
      };
      for (const [t, lines] of Object.entries(books)) writeFileSync(join(dir, `${t}.txt`), lines.join(nl), "utf8");
      await chooseTask(page, "auto", "folder-otzaria");
      await expect(page).toHaveURL(/#\/guided\/files$/);
      const main = page.locator("main.guided");
      const chooser = page.waitForEvent("filechooser");
      await main.getByRole("button", { name: "הספרים: תיקייה" }).click();
      await (await chooser).setFiles(dir);
      await expect(main.getByRole("list", { name: "נבחרו" })).toContainText("5 ספרים", { timeout: 30_000 });
      await main.locator(".guided-foot").getByRole("button", { name: /^הבא/ }).click();
      await expect(main.getByRole("status")).toContainText("נמצאו 5 ספרים");
      await snap(page, "guided-books");
    });
  });
}

/* Desktop only: the side panel dragged to its narrowest (the splitter exists only in the multi-column layouts). */
test.describe("desktop", () => {
  test.use({ viewport: WIDTHS[0][1] });

  test("side panel at its narrowest with a long unbroken book name (issue 26b)", async ({ page }) => {
    await openFiles(page, [
      txt("ביאורמפורטעלהתורהמאתרבימשהבןמיימוןזלהה.txt", ["<h1>ביאורמפורטעלהתורהמאתרבימשהבןמיימוןזלהה</h1>", "שורה אחת", "שורה שתיים"]),
    ]);
    await pickBooks(page, /ביאורמפורט/, /^בראשית/);
    await page.locator(".reader.source .ln").nth(1).locator(".tx").click();
    await page.locator(".reader.target .ln").nth(2).locator(".tx").click();
    await page.getByRole("separator", { name: "שינוי רוחב הפאנלים" }).last().focus();
    for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".builder .end.set")).toHaveCount(2);
    await snap(page, "side-panel-narrow");
  });
});

/*
 * The screens of the stacked work (PR 3), at the three widths: the coverage section, the unlinked marks in a reader, the
 * checklist of "books I choose", the pair mode with more targets, the guided plan with its pairs and counts, the alt_toc
 * dialog, and the page of all the link types.
 */
const MINE = txt("ספר שלי.txt", ["<h1>ספר שלי</h1>", "שורה שנייה", "שורה שלישית", "שורה רביעית", "<h2>פרק ב</h2>", "שורה שישית", "שורה שביעית"]);
const MINE_LINKS = {
  name: "ספר שלי_links.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify([2, 6].map((l) => ({ line_index_1: l, heRef_2: "בראשית", path_2: "בראשית.txt", line_index_2: 3, "Conection Type": "reference" })))),
};
const BIUR_B = txt("ביאור ב על בראשית.txt", ["<h1>ביאור ב על בראשית</h1>", "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `ביאור ב לפסוק ${i + 1}`])]);

for (const [width, viewport] of WIDTHS) {
  test.describe(`${width} (stacked screens)`, () => {
    test.use({ viewport });

    test("coverage: the unlinked ranges of a book and the counts by what links each line", async ({ page }) => {
      await openFiles(page, [MINE, MINE_LINKS]);
      await pickBooks(page, "ספר שלי", /^בראשית/);
      await page.getByRole("tab", { name: /בדיקה/ }).click();
      const cov = page.locator("details.coverage");
      await cov.locator("summary").click();
      await cov.getByRole("button", { name: "חישוב כיסוי" }).click();
      await expect(cov.locator(".cov-range").first()).toBeVisible();
      await snap(page, "coverage");
    });

    test("reader: the lines no link touches are marked, by a sign and not by colour alone", async ({ page }) => {
      await openFiles(page, [MINE, MINE_LINKS]);
      await pickBooks(page, "ספר שלי", /^בראשית/);
      await page.locator(".reader.source").getByRole("checkbox", { name: "סימון שורות בלי קישור" }).check();
      await expect(page.locator(".reader.source .ln.unlinked").first()).toBeVisible();
      await snap(page, "unlinked-marks");
    });

    test("max-link: the books I choose, ticked from a searchable list", async ({ page }) => {
      await openFiles(page, [BIUR, BIUR_B]);
      await page.getByRole("tab", { name: /הצעות/ }).click();
      await page.getByRole("radio", { name: "קישור מרבי" }).click();
      await page.getByRole("radio", { name: "ספרים שאבחר" }).click();
      const g = page.getByRole("group", { name: "הספרים לקישור" });
      await g.getByRole("checkbox", { name: /^ביאור על בראשית/ }).check();
      await g.getByRole("checkbox", { name: /^ביאור ב על בראשית/ }).check();
      await expect(page.locator(".ml-plan-line")).toBeVisible();
      await snap(page, "maxlink-books");
    });

    test("pair mode: more targets for one book, every method that fits merged", async ({ page }) => {
      await openFiles(page, [BIUR]);
      await pickBooks(page, "ביאור על בראשית", /^בראשית/);
      await page.getByRole("tab", { name: /הצעות/ }).click();
      const more = page.locator("details.more-targets");
      await more.locator("summary").click();
      await more.getByRole("group", { name: "עוד ספרי יעד" }).getByRole("checkbox", { name: /^רש"י על בראשית/ }).check();
      await page.getByRole("checkbox", { name: /כל השיטות שמתאימות/ }).check();
      await snap(page, "pair-targets");
    });

    test("alt_toc: the structure editor with its explanation, on a small screen too", async ({ page }) => {
      const heads = txt("חומש שלי.txt", ["<h1>חומש שלי</h1>", ...Array.from({ length: 12 }, (_, i) => [`<h2>פרשה ${i + 1}</h2>`, `שורה ${i + 1}`]).flat()]);
      await openFiles(page, [heads]);
      await page.getByRole("tab", { name: /קישורים/ }).first().click();
      await page.getByRole("button", { name: /^מבני כותרות/ }).click();
      const dlg = page.getByRole("dialog");
      await dlg.getByLabel("הספר").selectOption("חומש שלי");
      await dlg.getByLabel("מפתח המבנה החדש (באנגלית)").fill("Parasha");
      await dlg.getByRole("button", { name: "מבנה חדש" }).click();
      await dlg.getByRole("button", { name: "מילוי מכותרות הספר" }).click();
      await expect(dlg.getByLabel("כותרת צומת 12", { exact: true })).toBeVisible();
      await dlg.locator("details.alt-why > summary").click();
      await snap(page, "alt-toc");
    });

    test("link types: the page of all of them, grouped, with where each shows in Otzaria", async ({ page }) => {
      await openFiles(page, [MINE]);
      await pickBooks(page, "ספר שלי", /^בראשית/);
      await page.getByRole("button", { name: "מה כל סוג אומר?" }).click();
      await expect(page.getByRole("dialog", { name: "סוגי הקישור" })).toBeVisible();
      await snap(page, "types-help");
    });

    test("guided plan, advanced: the controls of each pair — include, link type, confidence, cost, what will not run", async ({ page }) => {
      const dir = join(test.info().outputPath(), "הספרים שלי");
      mkdirSync(dir, { recursive: true });
      const commentary = (t: string) => [`<h1>${t}</h1>`, "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `${t}: ביאור לפסוק ${i + 1}`])];
      writeFileSync(join(dir, "ביאור על בראשית.txt"), commentary("ביאור על בראשית").join(nl), "utf8");
      writeFileSync(join(dir, "פירוש קצר על בראשית.txt"), ["<h1>פירוש קצר על בראשית</h1>", "בראשית ברא - בשביל התורה.", "והארץ היתה תהו ובהו - עוד שורה."].join(nl), "utf8");
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
      await setAdvanced(page);
      const pairs = main.locator("details.guided-pairs");
      if (!(await pairs.evaluate((el) => (el as HTMLDetailsElement).open))) await pairs.locator("summary").click();
      const row = pairs.locator('.pair-row[data-pair="פירוש קצר על בראשית>בראשית"]');
      await expect(row.locator(".pair-fit")).toContainText("הכותרות", { timeout: 30_000 });
      await pairs.locator('.pair-row[data-pair="ביאור על בראשית>בראשית"]').getByLabel(/^סוג הקישור/).selectOption("targum");
      await pairs.locator('.pair-row[data-pair="ביאור על בראשית>בראשית"]').getByLabel(/^הצעות מרמת ביטחון/).selectOption("high");
      await row.getByRole("checkbox", { name: /לכלול את הזוג/ }).uncheck();
      await pairs.scrollIntoViewIfNeeded();
      await snap(page, "guided-pair-controls");
    });

    test("db links of a personal database: the flags — counted, a filter, and said on each link in words", async ({ page }) => {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "קבצים", exact: true }).click();
      await (await chooser).setFiles([{ name: "personal.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/pdc-personal-mini.db")) }]);
      const booksTab = page.getByRole("tab", { name: "ספרים" });
      await expect(page.locator(".side-panel")).toBeVisible({ timeout: 30_000 });
      if (await booksTab.isVisible()) await booksTab.click();
      await page.locator(".book-list li").filter({ hasText: "PLACEHOLDER commentary on official" }).first().locator('button.side-btn[data-side="source"]').click({ timeout: 30_000 });
      await page.getByRole("tab", { name: /קישורים/ }).first().click();
      await page.getByRole("tab", { name: /קישורים מהמסד/ }).click();
      const panel = page.locator(".dbl");
      await expect(panel.locator(".dbl-item").first()).toBeVisible({ timeout: 30_000 });
      await panel.locator(".dbl-flags-sum summary").click();
      await panel.locator(".dbl-flags-sum").getByRole("button", { name: /כפילות הפוכה/ }).click();
      await panel.locator(".dbl-flags-sum summary").click(); // folded again, so that the flagged links are in view
      await expect(panel.locator(".dbl-flags").first()).toBeVisible();
      await snap(page, "db-links-flags");
    });

    test("coverage: the count kept with the project, shown as out of date until the book is counted again", async ({ page }) => {
      await openFiles(page, [MINE, MINE_LINKS]);
      await pickBooks(page, "ספר שלי", /^בראשית/);
      await page.getByRole("tab", { name: /בדיקה/ }).click();
      const cov = page.locator("details.coverage");
      await cov.locator("summary").click();
      await cov.getByRole("button", { name: "חישוב כיסוי" }).click();
      await expect(cov.locator(".cov-range").first()).toBeVisible();
      await cov.getByLabel("הספר").selectOption("target");
      await cov.getByLabel("הספר").selectOption("source");
      await expect(cov.locator(".cov-stamp[data-stale]")).toBeVisible();
      await snap(page, "coverage-kept");
    });

    test("export: links.csv for a personal library — when to use it, the files, what is left out and why", async ({ page }) => {
      const mineCsv = {
        name: "ספר שלי_links.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(["line_index_1,heRef_2,path_2,line_index_2,Conection Type", "2,בראשית,בראשית.txt,3,source", "3,בראשית,בראשית.txt,4,reference"].join(nl)),
      };
      await openFiles(page, [MINE, mineCsv]);
      await setAdvanced(page);
      await page.getByRole("button", { name: /^ייצוא/ }).click();
      const dialog = page.getByRole("dialog", { name: "ייצוא קובצי קישורים" });
      await dialog.getByLabel("פורמט קובצי הקישורים").selectOption("personal-csv", { timeout: 30_000 });
      await expect(dialog.locator(".files")).toContainText("links.csv", { timeout: 30_000 });
      await snap(page, "export-personal-csv");
    });

    test("repository analysis: the counts, the books with no links, a book's details, and the pairs the tool suggests", async ({ page }) => {
      await chooseTask(page, "repo", "analyze");
      const sheet = page.getByRole("dialog", { name: "ניתוח מאגר והשלמת קישורים" });
      const chooser = page.waitForEvent("filechooser");
      await sheet.getByRole("button", { name: "המסד: מסד נתונים" }).click();
      await (await chooser).setFiles([DB]);
      await expect(sheet.locator(".steps > li").first()).toHaveClass(/done/, { timeout: 30_000 });
      await sheet.getByRole("button", { name: "התחלה" }).click();
      const dlg = page.locator("dialog.repository");
      await dlg.getByRole("button", { name: "ניתוח הקישורים של הספרים" }).click();
      await expect(dlg.getByText(/נקראו הקישורים של כל/)).toBeVisible({ timeout: 60_000 });
      await dlg.locator("details.repo-more summary").click();
      await dlg.locator(".body").evaluate((el) => (el.scrollTop = 0));
      await snap(page, "repository-counts");
      await dlg.locator("details.repo-more summary").click();
      await dlg.getByLabel("חיפוש ספר").fill("ארצות החיים");
      await dlg.locator(".repo-book", { hasText: "6 קישורים" }).first().getByRole("button", { name: /^פרטי הספר/ }).click();
      await expect(dlg.getByRole("list", { name: "הספרים המקושרים" })).toBeVisible({ timeout: 30_000 });
      await dlg.locator(".repo-h").first().evaluate((el) => el.scrollIntoView({ block: "start" }));
      await snap(page, "repository");
      await dlg.getByLabel("חיפוש ספר").fill("");
      await dlg.getByRole("button", { name: "הצעת זוגות לפי השמות" }).click();
      await dlg.getByLabel("גם ספרים שכבר מקושרים").check();
      await expect(dlg.locator(".repo-pair").first()).toBeVisible({ timeout: 30_000 });
      await dlg.locator(".repo-pair").first().getByRole("checkbox").check();
      await dlg.locator(".repo-pair").first().scrollIntoViewIfNeeded();
      await dlg.locator(".repo-pairs").evaluate((el) => el.scrollIntoView({ block: "start" }));
      await snap(page, "repository-pairs");
    });

    test("guided flow: the plan with the pairs, the counts of the links that exist, and what the file will hold", async ({ page }) => {
      const dir = join(test.info().outputPath(), "הספרים שלי");
      mkdirSync(dir, { recursive: true });
      const commentary = (t: string) => [`<h1>${t}</h1>`, "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `${t}: ביאור לפסוק ${i + 1}`])];
      writeFileSync(join(dir, "ביאור על בראשית.txt"), commentary("ביאור על בראשית").join(nl), "utf8");
      writeFileSync(join(dir, "פירוש קצר על בראשית.txt"), ["<h1>פירוש קצר על בראשית</h1>", "בראשית ברא - בשביל התורה.", "והארץ היתה תהו ובהו - תמהה ומשוממה."].join(nl), "utf8");
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
      await main.locator("details.guided-pairs > summary").click();
      await expect(main.locator(".guided-pairs .pair-fit").first()).toContainText("הכותרות", { timeout: 30_000 });
      await expect(main.locator(".guided-existing")).toContainText(/במסד [\d,]+/, { timeout: 30_000 });
      await main.locator(".guided-final").scrollIntoViewIfNeeded();
      await snap(page, "guided-plan");
    });
  });
}
