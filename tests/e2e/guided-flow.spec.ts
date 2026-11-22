import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { expect, test, type Page } from "@playwright/test";
import { chooseTask, distUrl, watchPage } from "./helpers";

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
  await chooseTask(page, "auto", "folder-otzaria");
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
  // the estimate in words reads on one line, not broken over three (V5 UX audit U23)
  const estimateLines = await stats.locator(".stat.text b").evaluate((b) => {
    const r = document.createRange();
    r.selectNodeContents(b);
    return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
  });
  expect(estimateLines).toBe(1);
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
  // one by one is the default: approving a group is a closed section (V5 UX audit U21)
  await expect(main.locator("details.bulk-approve")).not.toHaveAttribute("open", "");
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
  await chooseTask(page, "auto", "several");
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

/*
 * The run step (V5 UX audit U16, the owner's choice B): ONE bar with the time left — not a second in the
 * app bar nor a third in the job card — "השהיה" and "עצירה" (no "ביטול" for the same thing), and the
 * progress per method and per book under "פרטים". Seen while the job runs: the page records what is on
 * screen the moment the fourth book is done, then pauses through the step's own button.
 */
test("guided flow: the run shows one bar, pause and stop, and the details on request", async ({ page }) => {
  test.slow();
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`ביאור ${i + 1} על בראשית`, commentary(`ביאור ${i + 1} על בראשית`)]));
  const dir = folder("שלושים", many);
  await page.goto(distUrl);
  await chooseTask(page, "auto", "folder-otzaria");
  const main = page.locator("main.guided");
  const next = main.locator(".guided-foot").getByRole("button", { name: /^הבא/ });
  const chooser = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: "הספרים: תיקייה" }).click();
  await (await chooser).setFiles(dir);
  await expect(main.getByRole("list", { name: "נבחרו" })).toContainText("30 ספרים", { timeout: 30_000 });
  await next.click();
  await next.click();
  const dbChooser = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: "מסד אוצריא: מסד נתונים" }).click();
  await (await dbChooser).setFiles([DB]);
  await expect(main.getByText("כל ספרי הבסיס נמצאו.")).toBeVisible({ timeout: 30_000 });
  await next.click();
  await expect(page).toHaveURL(/#\/guided\/plan$/);
  await page.evaluate(() => {
    type Job = { books: { status: string }[] };
    const w = globalThis as unknown as { __linker: { maxLink: { job: { subscribe(f: (j: Job | null) => void): () => void } } }; __run?: unknown };
    const stop = w.__linker.maxLink.job.subscribe((j) => {
      if (!j || j.books.filter((b) => b.status === "done" || b.status === "no-match").length < 4) return;
      const step = document.querySelector(".guided-run");
      const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.getClientRects().length).map((b) => b.textContent?.trim());
      w.__run = {
        bars: [...document.querySelectorAll("progress")].filter((p) => p.getClientRects().length).length,
        appBarTask: !!document.querySelector(".app-bar .task"),
        cancel: buttons.includes("ביטול"),
        pause: !!step && [...step.querySelectorAll("button")].some((b) => b.textContent === "השהיה"),
        stop: !!step && [...step.querySelectorAll("button")].some((b) => b.textContent === "עצירה"),
        details: step?.querySelector("details summary")?.textContent ?? null,
        detailsOpen: !!step?.querySelector("details[open]"),
        jobCard: !!document.querySelector('[aria-label="עבודת הקישור המרבי"]'),
      };
      queueMicrotask(stop);
      [...(step?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent === "השהיה")?.click();
    });
  });
  await main.getByRole("button", { name: "הפעלה" }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __run?: unknown }).__run ?? null), { timeout: 60_000 }).not.toBeNull();
  const run = await page.evaluate(() => (globalThis as unknown as { __run: Record<string, unknown> }).__run);
  expect(run).toEqual({ bars: 1, appBarTask: false, cancel: false, pause: true, stop: true, details: "פרטים: לפי שיטה ולפי ספר", detailsOpen: false, jobCard: false });
  // paused: the finished books are kept, and the job's card offers to continue
  const card = page.getByRole("region", { name: "עבודת הקישור המרבי" });
  await expect(card.getByRole("status")).toContainText("קישור מרבי: מושהה", { timeout: 30_000 });
  await expect(card.getByRole("button", { name: /^המשך \([\d,]+ ספרים\)$/ })).toBeEnabled();
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * Approving a group (V5 UX audit U21, the owner's decision): only when the user opens it; the count
 * shown before the button is exactly what is approved; "possible" and "ambiguous" only when ticked; one
 * "ביטול האישור" takes it all back.
 */
test("guided flow: approving a group approves exactly the count it showed, and is undone in one step", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  const dir = folder("קבוצה", BOOKS);
  await page.goto(distUrl);
  await chooseTask(page, "auto", "folder-otzaria");
  const main = page.locator("main.guided");
  const next = main.locator(".guided-foot").getByRole("button", { name: /^הבא/ });
  const chooser = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: "הספרים: תיקייה" }).click();
  await (await chooser).setFiles(dir);
  await expect(main.getByRole("list", { name: "נבחרו" })).toContainText("6 ספרים", { timeout: 30_000 });
  await next.click();
  await next.click();
  const dbChooser = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: "מסד אוצריא: מסד נתונים" }).click();
  await (await dbChooser).setFiles([DB]);
  await expect(main.getByText("כל ספרי הבסיס נמצאו.")).toBeVisible({ timeout: 30_000 });
  await next.click();
  await main.getByRole("button", { name: "הפעלה" }).click();
  await expect(main.getByRole("button", { name: /^אישור כל [\d,]+ הוודאיות$/ })).toBeVisible({ timeout: 30_000 });
  const links = () => page.evaluate(() => (globalThis as unknown as { __linker: { allLinks: { value: unknown[] } } }).__linker.allLinks.value.length);
  expect(await links()).toBe(0);

  const bulk = main.locator("details.bulk-approve");
  await bulk.locator("summary").click();
  const preview = bulk.getByRole("status").first();
  await expect(preview).toContainText('הצעות "אפשרית" ו"עמומה" לא נכללות אלא אם סימנתם אותן');
  await expect(bulk.getByRole("checkbox", { name: "ודאית" })).toBeChecked();
  await expect(bulk.getByRole("checkbox", { name: "גבוהה" })).toBeChecked();
  await expect(bulk.getByRole("checkbox", { name: "אפשרית" })).not.toBeChecked();
  await expect(bulk.getByRole("checkbox", { name: "עמומה" })).not.toBeChecked();
  const shown = Number((await preview.locator("b").textContent())!.match(/יאושרו ([\d,]+) הצעות/)![1]!.replace(/,/g, ""));
  expect(shown).toBeGreaterThan(0);
  // one book narrows the count
  await bulk.getByRole("radio", { name: "ספר אחד" }).check();
  await bulk.getByRole("combobox", { name: "הספר" }).selectOption("ביאור קצר על בראשית");
  const forBook = Number((await preview.locator("b").textContent())!.match(/([\d,]+)/)![1]!.replace(/,/g, ""));
  expect(forBook).toBeLessThan(shown);
  await bulk.getByRole("radio", { name: "כל הספרים והשיטות" }).check();
  await bulk.getByRole("button", { name: `אישור ${shown} ההצעות` }).click();
  await expect(bulk.getByText(`אושרו ${shown} הצעות.`)).toBeVisible();
  // no Sefaria span among these: a record per suggestion
  expect(await links()).toBe(shown);
  await bulk.getByRole("button", { name: "ביטול האישור" }).click();
  await expect.poll(links).toBe(0);
  await plain(page);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * Issues 21 and 26 (screens): before the run the plan says, per pair, whether the commentary's titles fit its base (the
 * headings method is only right then) and why, lets the user name the method of one pair, and "force dibur-hamatchil for
 * all pairs". Forcing a method where it does not fit warns. Basic mode keeps this folded; advanced opens it.
 */
test("guided flow: the plan's pairs — title fit with reasons, a method per pair, force dibur-hamatchil, warnings", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const dir = folder("הספרים שלי", { "ביאור על בראשית": BOOKS["ביאור על בראשית"]!, "פירוש קצר על בראשית": BOOKS["פירוש קצר על בראשית"]! });
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

  // folded in simple mode; one line per pair inside, the verdict only when asked for
  const pairs = main.locator("details.guided-pairs");
  await expect(pairs).not.toHaveAttribute("open", "");
  await pairs.locator("summary").click();
  // each pair is a row named by its key (dependant>base); a commentary is also paired with the commentaries on the same base
  const row = (dep: string) => pairs.locator(`.pair-row[data-pair="${dep}>בראשית"]`);
  await expect(row("ביאור על בראשית").locator(".pair-fit")).toContainText("הכותרות מתאימות", { timeout: 30_000 });
  await expect(row("פירוש קצר על בראשית").locator(".pair-fit")).toContainText("הכותרות לא מתאימות", { timeout: 30_000 });
  await expect(row("פירוש קצר על בראשית").locator(".pair-fit")).toContainText("אין כותרות"); // the reason, with the number behind it
  await expect(row("פירוש קצר על בראשית").locator(".pair-warn")).toHaveCount(0);

  // naming headings for the pair whose titles do not fit: allowed, with a warning that says why
  await row("פירוש קצר על בראשית").getByLabel(/^שיטה לזוג/).selectOption("both");
  await expect(row("פירוש קצר על בראשית").locator(".pair-warn")).toContainText("אינן של ספר הבסיס");
  await row("פירוש קצר על בראשית").getByLabel(/^שיטה לזוג/).selectOption("");
  await expect(row("פירוש קצר על בראשית").locator(".pair-warn")).toHaveCount(0);

  // a pair with a method of its own: forcing dibur-hamatchil for all starts from the defaults (a named pair would bypass it)
  await row("ביאור על בראשית").getByLabel(/^שיטה לזוג/).selectOption("headings");
  // force dibur-hamatchil for all pairs: the plan then runs no other method
  await main.getByRole("checkbox", { name: /לכפות דיבור המתחיל לכל הזוגות/ }).check();
  const methods = main.locator(".guided-books li b");
  await expect(methods).toHaveText(["לפי דיבור המתחיל"]);
  await expect(main.locator(".pair-force-note")).toContainText("גם היכן שהכותרות מתאימות");
  await expect(main.locator(".pair-force-note")).toContainText("שיטת הערות השוליים לא תרוץ");
  await expect(row("ביאור על בראשית").getByLabel(/^שיטה לזוג/)).toHaveValue("");
  await main.getByRole("checkbox", { name: /לכפות דיבור המתחיל לכל הזוגות/ }).uncheck();
  expect(await methods.count()).toBeGreaterThan(1);
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});

/*
 * 3.2: before the run the plan says how many links the chosen books ALREADY have (the project's and the open database's)
 * and what will and will not go into the final file.
 */
test("guided flow: the plan counts the existing links of the chosen books and says what the file will hold and what is held", async ({ page }) => {
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const dir = folder("הספרים שלי", { "ביאור על בראשית": BOOKS["ביאור על בראשית"]! });
  await page.goto(distUrl);
  await chooseTask(page, "auto", "folder-otzaria");
  const main = page.locator("main.guided");
  const next = main.locator(".guided-foot").getByRole("button", { name: /^הבא/ });
  const chooser = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: "הספרים: תיקייה" }).click();
  await (await chooser).setFiles(dir);
  await expect(main.getByRole("list", { name: "נבחרו" })).toContainText("1 ספרים", { timeout: 30_000 });
  await next.click();
  await next.click();
  const dbChooser = page.waitForEvent("filechooser");
  await main.getByRole("button", { name: "מסד אוצריא: מסד נתונים" }).click();
  await (await dbChooser).setFiles([DB]);
  await expect(main.getByText("כל ספרי הבסיס נמצאו.")).toBeVisible({ timeout: 30_000 });
  await next.click();
  await expect(page).toHaveURL(/#\/guided\/plan$/);

  const existing = main.locator(".guided-existing");
  await expect(existing).toContainText("בפרויקט 0", { timeout: 30_000 });
  await expect(existing).toContainText(/במסד [\d,]+/, { timeout: 30_000 });
  const dbCount = Number((await existing.textContent())!.match(/במסד ([\d,]+)/)![1]!.replace(/,/g, ""));
  expect(dbCount).toBeGreaterThan(0); // the database slice links Bereshit to its commentaries
  const final = main.locator(".guided-final");
  await expect(final).toContainText("קישורי המסד לא נכתבים");
  await expect(final).toContainText("מוחזק");
  expect(seen.errors).toEqual([]);
  expect(seen.external).toEqual([]);
});
