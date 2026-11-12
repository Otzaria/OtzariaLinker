import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * The guided flow "link a folder to Otzaria" in the built single file, from the home card to the
 * download, without visiting the workspace: a folder of two commentaries on a book of the database,
 * a book with its notes book and a book with no relation → what was found → the Otzaria database,
 * asked for by name → the plan → run → approve the certain ones and one to check → the check → the
 * download (a ZIP of links files) and "what now". Simple mode shows no field of the links file. A
 * reload in the middle continues where the flow was.
 */
const nl = String.fromCharCode(10);
const HEB = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
const DB = { name: "seforim.db", mimeType: "application/octet-stream", buffer: readFileSync(resolve("tests/fixtures/db/seforim-v7-mini.db")) };
const SHOTS = process.env.SHOTS_DIR;
/** what a regular user must not meet (the product audit's list, scripts/audit/harness.mjs) */
const JARGON = /ref_[12]\b|heRef|line_index|Conection Type|path_2|\bJSON\b|\bSQLite\b|\bschema\b|\bprovenance\b|\bundefined\b|\bNaN\b|\bnull\b/;

function folder(name: string, books: Record<string, string[]>): string {
  const dir = join(test.info().outputPath(), name);
  mkdirSync(dir, { recursive: true });
  for (const [title, lines] of Object.entries(books)) writeFileSync(join(dir, `${title}.txt`), lines.join(nl), "utf8");
  return dir;
}
const commentary = (t: string) => [`<h1>${t}</h1>`, "<h2>פרק א</h2>", ...HEB.flatMap((h, i) => [`<h3>פסוק ${h}</h3>`, `${t}: ביאור לפסוק ${i + 1}`])];
const BOOKS = {
  "ביאור על בראשית": commentary("ביאור על בראשית"),
  "ביאור קצר על בראשית": commentary("ביאור קצר על בראשית"),
  "ספר דוגמה": ["<h1>ספר דוגמה</h1>", "<h2>פרק א</h2>", "שורה ראשונה עם הערה (1) ועוד אחת (2).", "<h2>פרק ב</h2>", "כאן המספור מתחיל שוב (1)."],
  "הערות לספר דוגמה": ["<h1>הערות לספר דוגמה</h1>", "<h2>פרק א</h2>", "(1) הערה ראשונה בפרק א.", "(2) הערה שנייה בפרק א.", "<h2>פרק ב</h2>", "(1) הערה ראשונה בפרק ב."],
  "חידושים": ["שורה אחת של חידושים."],
  // no verse headings: only its opening words tie it to the verses
  "פירוש קצר על בראשית": ["<h1>פירוש קצר על בראשית</h1>", "בראשית ברא - בשביל התורה.", "והארץ היתה תהו ובהו - תמהה ומשוממה.", "ורוח אלהים מרחפת - כסא הכבוד.", "ויבדל אלהים - ראהו שאינו כדאי."],
};

/** Every hash the page showed: the flow must never pass through the workspace. */
async function trackHashes(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __hashes: string[] }).__hashes = [location.hash];
    addEventListener("hashchange", () => (window as unknown as { __hashes: string[] }).__hashes.push(location.hash));
  });
}
const hashes = (page: Page) => page.evaluate(() => (window as unknown as { __hashes: string[] }).__hashes);

/** The guided screen's text, simple mode: no field names of the file format. */
async function plain(page: Page) {
  const text = await page.locator("main.guided").innerText();
  expect(text, "a technical term on the guided screen").not.toMatch(JARGON);
  return text;
}
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  // the step itself, without the notices that fade over it
  await page.locator(".notices").evaluate((e) => ((e as HTMLElement).style.visibility = "hidden")).catch(() => {});
  await page.screenshot({ path: `${SHOTS}/guided-${name}.png` });
  await page.locator(".notices").evaluate((e) => ((e as HTMLElement).style.visibility = "")).catch(() => {});
}
/** The notices too: the flow's own steps raise some (opening, the run, the references filled before the export). */
async function plainNotices(page: Page) {
  const text = await page.locator(".notices").innerText().catch(() => "");
  expect(text, "a technical term in a notice").not.toMatch(JARGON);
}

test("guided flow: folder → books → database → plan → run → approve → check → download, no workspace", async ({ page }) => {
  const seen = watchPage(page);
  await trackHashes(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  const dir = folder("הספרים שלי", BOOKS);
  await page.goto(distUrl);

  // the home card starts the flow
  await page.locator(".task-card", { hasText: "תיקייה מול אוצריא" }).click();
  await expect(page).toHaveURL(/#\/guided\/files$/);
  const main = page.locator("main.guided");
  const next = main.locator(".guided-foot").getByRole("button", { name: /^הבא/ });
  await expect(next).toBeDisabled();

  // 1. the folder
  const chooser = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: "הספרים: תיקייה" }).click();
  await (await chooser).setFiles(dir);
  await expect(main.getByRole("list", { name: "נבחרו" })).toContainText("6 ספרים", { timeout: 30_000 });
  await expect(page).toHaveURL(/#\/guided\/files$/); // opening the books does not leave the flow
  await shot(page, "1-files");
  await plain(page);
  await next.click();

  // 2. what was found: one line per group, and what is missing
  await expect(page).toHaveURL(/#\/guided\/books$/);
  await expect(main.getByRole("status")).toContainText("נמצאו 6 ספרים");
  const groups = main.locator(".guided-groups > li");
  await expect(groups.filter({ hasText: 'ספר הערות, והספר שעליו נכתב: "ספר דוגמה"' })).toHaveCount(1);
  await expect(groups.filter({ hasText: '3 ספרים כתובים על "בראשית"' })).toHaveCount(1);
  await expect(groups.filter({ hasText: "חידושים" })).toHaveCount(1);
  await shot(page, "2-books");
  await plain(page);
  await next.click();

  // 3. the database, asked for by the base it is needed for
  await expect(page).toHaveURL(/#\/guided\/db$/);
  await expect(main.locator(".guided-card.warn")).toContainText('צריך את מסד אוצריא בשביל: "בראשית"');
  const dbChooser = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: "מסד אוצריא: מסד נתונים" }).click();
  await (await dbChooser).setFiles([DB]);
  await expect(main.getByText("כל ספרי הבסיס נמצאו.")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/#\/guided\/db$/);
  await shot(page, "3-db");
  await plain(page);
  await next.click();

  // 4. the plan: counts, methods, time, the purpose in plain words, problems known before the run
  await expect(page).toHaveURL(/#\/guided\/plan$/);
  const stats = main.getByRole("status", { name: "התוכנית" });
  await expect(stats).toContainText("6ספרים");
  await expect(stats).toContainText("זמן משוער");
  await expect(main.getByRole("group", { name: "בשביל מה הקישורים?" }).getByRole("radio", { name: /לשלוח לספריית אוצריא/ })).toBeChecked();
  await expect(main).toContainText("לא ידועה מראש אף בעיה");
  await shot(page, "4-plan");
  await plain(page);

  // reload in the middle: the flow is offered again, and continues once its books are open again
  await page.waitForTimeout(800); // the record is written a moment after the last change
  await page.reload();
  await expect(page).toHaveURL(/#\/guided\/files$/);
  await expect(main.locator(".guided-card.warn")).toContainText('הגעתם לשלב "התוכנית"');
  await main.getByRole("button", { name: "המשך מאיפה שהפסקתי" }).click();
  const again = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: "הספרים: תיקייה" }).click();
  await (await again).setFiles(dir);
  await expect(main.getByRole("list", { name: "נבחרו" })).toContainText("6 ספרים", { timeout: 30_000 });
  // the database is opened from step 3, and the step "plan" is reached in one click once it is open
  await main.getByRole("button", { name: 'המשך מהשלב "התוכנית"' }).click();
  await expect(page).toHaveURL(/#\/guided\/db$/); // the base is missing again: the flow stops where it is needed
  const dbAgain = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: "מסד אוצריא: מסד נתונים" }).click();
  await (await dbAgain).setFiles([DB]);
  await expect(main.getByText("כל ספרי הבסיס נמצאו.")).toBeVisible({ timeout: 30_000 });
  await next.click();
  await expect(page).toHaveURL(/#\/guided\/plan$/);

  // 5. run, then approve: all certain at once, and one of the rest on its card
  await main.getByRole("button", { name: "הפעלה" }).click();
  await expect(page).toHaveURL(/#\/guided\/run$/);
  const approveAll = main.getByRole("button", { name: /^אישור כל [\d,]+ הוודאיות$/ });
  await expect(approveAll).toBeVisible({ timeout: 30_000 });
  await shot(page, "5-run");
  await plain(page);
  await approveAll.click();
  await expect(main.getByRole("button", { name: "כל הוודאיות אושרו" })).toBeDisabled();
  // the commentary without verse headings is found by its opening words: not all certain, so there is something to check
  const review = main.getByRole("button", { name: "מעבר עליהן" });
  await expect(review).toBeEnabled();
  await review.click();
  const card = main.getByRole("region", { name: "ההצעות לבדיקה" });
  await expect(card.locator(".side-badge.source")).toBeVisible();
  await plain(page);
  await card.getByRole("button", { name: /^אישור/ }).click();
  await plain(page);
  await next.click();

  // 6. the check runs by itself; then the download and "what now"
  await expect(page).toHaveURL(/#\/guided\/finish$/);
  const download = main.getByRole("button", { name: /^הורדת/ });
  await expect(download).toBeEnabled({ timeout: 30_000 });
  await expect(main.locator(".guided-card").first()).toContainText(/הכול תקין|מה לעשות/);
  await plain(page);
  await plainNotices(page);
  const dl = page.waitForEvent("download");
  await download.click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/\.zip$/);
  const zip = unzipSync(new Uint8Array(readFileSync((await file.path())!)));
  const names = Object.keys(zip);
  expect(names).toContain("links/ביאור על בראשית_links.json");
  expect(names).toContain("_report.txt");
  const records = JSON.parse(strFromU8(zip["links/ביאור על בראשית_links.json"]!)) as Record<string, unknown>[];
  expect(records.length).toBeGreaterThan(0);
  expect(records.every((r) => typeof r["heRef_2"] === "string" && Number.isInteger(r["line_index_1"]))).toBe(true);
  await expect(main.getByRole("heading", { name: "מה עכשיו?" })).toBeVisible();
  await shot(page, "6-finish");
  await plain(page);

  expect((await hashes(page)).filter((h) => h.startsWith("#/workspace") || h.startsWith("#/maxlink"))).toEqual([]);
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("guided flow: the books already hold their bases — no database step; a way out to the workspace at every step", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const dir = folder("עם בסיס", { "ספר דוגמה": BOOKS["ספר דוגמה"], "הערות לספר דוגמה": BOOKS["הערות לספר דוגמה"] });
  await page.goto(distUrl);
  await page.locator(".task-card", { hasText: "כמה ספרים יחד" }).click();
  const main = page.locator("main.guided");
  const chooser = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: "הספרים: תיקייה" }).click();
  await (await chooser).setFiles(dir);
  await expect(main.getByRole("list", { name: "נבחרו" })).toContainText("2 ספרים", { timeout: 30_000 });
  await main.getByRole("button", { name: /^הבא/ }).click();
  await expect(main).toContainText("לא צריך את מסד אוצריא");
  await expect(main.getByRole("list", { name: "השלבים" }).locator("li.skipped")).toHaveText(/מסד אוצריא \(לא נדרש\)/);
  await main.getByRole("button", { name: /^הבא/ }).click();
  await expect(page).toHaveURL(/#\/guided\/plan$/);
  await main.getByRole("button", { name: "חזרה" }).click();
  await expect(page).toHaveURL(/#\/guided\/books$/);

  // the way out: the workspace, at max-link on these books; and back
  await main.getByRole("button", { name: "פתיחה בסביבת העבודה" }).click();
  await expect(page).toHaveURL(/#\/maxlink$/);
  await expect(page.getByRole("status").filter({ hasText: "ספרים נבחרו" })).toContainText("2 ספרים נבחרו");
  await page.getByRole("button", { name: "חזרה להדרכה" }).click();
  await expect(page).toHaveURL(/#\/guided\/books$/);
});
