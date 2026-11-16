import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { distUrl, watchPage } from "./helpers";

/*
 * The max-link job (V5 P1-8) in the built single file: a folder of 20 commentaries and their base.
 * The worker call of one book fails the way an unreadable file does (Playwright hands a chosen folder to
 * the page in memory, so a file cannot really vanish under it; the failure is injected at the service,
 * everything else is the real app), and the others go on; after the reload it reads again. Pause in the middle → reload the tab → the job is offered again → choose
 * the folder again → continue: the books that finished before the reload are not run again → "run the
 * failed ones" runs only the book that failed → the per-book report.
 */
const nl = String.fromCharCode(10);
const HEB = ["א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט", "י"];
const BOOKS = 20;
const commentary = (n: number) => [`<h1>ביאור ${n} על בראשית</h1>`, ...HEB.flatMap((p, c) => [`<h2>פרק ${p}</h2>`, ...HEB.flatMap((v, i) => [`<h3>פסוק ${v}</h3>`, `ביאור ${n} לפרק ${c + 1} פסוק ${i + 1}: דברי הפירוש על המקרא הזה.`])])];
const base = ["<h1>בראשית</h1>", ...HEB.flatMap((p, c) => [`<h2>פרק ${p}</h2>`, ...HEB.map((v, i) => `(${v}) פסוק ${i + 1} של פרק ${c + 1}.`)])];

type Job = { state: string; books: { title: string; status: string; ms: number; why?: string }[] };
const job = (page: Page) => page.evaluate(() => (globalThis as unknown as { __linker: { maxLink: { job: { value: Job | null } } } }).__linker.maxLink.job.value);

async function chooseFolder(page: Page, dir: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "תיקייה", exact: true }).first().click();
  await (await chooser).setFiles(dir);
  await expect(page.locator(".source-row").first()).toBeVisible({ timeout: 30_000 });
}

test("max-link job: a failing book, pause → reload → continue → run the failed one again → per-book report", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "one Chromium run: the job itself is browser-independent (state/maxlink.ts)");
  test.setTimeout(180_000);
  const seen = watchPage(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const dir = join(test.info().outputPath(), "ביאורים");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "בראשית.txt"), base.join(nl), "utf8");
  for (let n = 1; n <= BOOKS; n++) writeFileSync(join(dir, `ביאור ${n} על בראשית.txt`), commentary(n).join(nl), "utf8");
  await page.goto(distUrl);
  await chooseFolder(page, dir);
  // one book cannot be read in this session (text-source.ts "text/unreadable")
  await page.evaluate((title) => {
    type Svc = { runMaxLink(steps: { source: { title: string } }[], o: unknown, opts: unknown): Promise<unknown> };
    const svc = (globalThis as unknown as { __linker: { maxLink: { service: Svc } } }).__linker.maxLink.service;
    const run = svc.runMaxLink.bind(svc);
    svc.runMaxLink = (steps, o, opts) =>
      steps[0]!.source.title === title ? Promise.reject(Object.assign(new Error(`אי אפשר לקרוא את הקובץ "${title}.txt": ייתכן שהוא השתנה או נמחק אחרי שנבחר. בחרו את התיקייה או הקבצים שוב.`), { code: "text/unreadable" })) : run(steps, o, opts);
  }, "ביאור 1 על בראשית");

  await page.getByRole("tab", { name: /הצעות/ }).click();
  await page.getByRole("radio", { name: "קישור מרבי" }).click();
  await expect(page.getByRole("status").filter({ hasText: "ספרים נבחרו" })).toContainText(`${BOOKS + 1} ספרים נבחרו`);
  // pause from the job's own button once five books are done (clicked in the page: the run does not wait for the test)
  await page.evaluate(() => {
    const ml = (globalThis as unknown as { __linker: { maxLink: { job: { subscribe(f: (j: Job | null) => void): () => void } } } }).__linker.maxLink;
    const stop = ml.job.subscribe((j) => {
      if (!j || j.books.filter((b) => b.status === "done" || b.status === "failed").length < 5) return;
      const pause = [...document.querySelectorAll<HTMLButtonElement>(".ml-job button")].find((b) => b.textContent === "השהיה");
      if (pause) (pause.click(), queueMicrotask(stop));
    });
  });
  await page.getByRole("button", { name: "הפעלת קישור מרבי" }).click();
  const panel = page.getByRole("region", { name: "עבודת הקישור המרבי" });
  await expect(panel.getByRole("status")).toContainText("קישור מרבי: מושהה", { timeout: 60_000 });
  const paused = (await job(page))!;
  const finished = paused.books.filter((b) => b.status === "done" || b.status === "no-match");
  expect(finished.length).toBeGreaterThanOrEqual(4);
  expect(finished.length).toBeLessThan(BOOKS);
  expect(paused.books.find((b) => b.title === "ביאור 1 על בראשית")).toMatchObject({ status: "failed", why: expect.stringContaining("אי אפשר לקרוא את הקובץ") });
  // the finished books' suggestions are there to review while the job is paused
  await expect(page.locator("details.ml-report")).toBeVisible();
  await expect(panel.getByRole("button", { name: /^המשך \([\d,]+ ספרים\)$/ })).toBeEnabled();

  // the tab is reloaded: the job waits in the browser, and asks for its folder again
  await page.waitForTimeout(1200); // the record is written a moment after the last book
  await page.reload();
  await chooseFolder(page, dir);
  await page.getByRole("tab", { name: /הצעות/ }).click();
  await expect(panel.getByRole("status")).toContainText("קישור מרבי שלא הסתיים");
  // the base runs too (the citations engine reads every chosen book): 21 books
  await expect(panel).toContainText(`${finished.length + 1} מתוך ${BOOKS + 1} ספרים`);
  await panel.getByRole("button", { name: /^המשך/ }).click();
  await expect(panel.getByRole("status")).toContainText("קישור מרבי: הסתיים", { timeout: 60_000 });
  let done = (await job(page))!;
  // the books that finished before the reload came back from storage: not run again (same time)
  for (const b of finished) expect(done.books.find((x) => x.title === b.title)).toMatchObject({ status: "done", ms: b.ms });
  const settled = (j: Job) => j.books.filter((b) => b.status === "done" || b.status === "no-match").length;
  expect(settled(done)).toBe(BOOKS);
  await expect(panel.locator(".ml-job-counts li.st-failed")).toHaveText("נכשל: 1");

  // only the failed book runs again (it reads in the new session)
  await panel.getByRole("button", { name: "הרצה חוזרת של 1 שנכשלו" }).click();
  // the job is "done" again once that book ran (the failed count drops as soon as it starts)
  await expect.poll(async () => { const j = await job(page); return j?.state === "done" ? settled(j) : -1; }, { timeout: 60_000 }).toBe(BOOKS + 1);
  await expect(panel.locator(".ml-job-counts li.st-failed")).toHaveCount(0);
  done = (await job(page))!;
  for (const b of finished) expect(done.books.find((x) => x.title === b.title)!.ms).toBe(b.ms);
  await expect(page.locator("details.ml-report .tile-booksChecked dd")).toHaveText(String(BOOKS + 1));
  const approveAll = page.getByRole("button", { name: /אישור כל הוודאיות/ });
  await expect(approveAll).toBeEnabled();

  // the per-book report
  const download = page.waitForEvent("download");
  await panel.getByRole("button", { name: "דוח הספרים" }).click();
  const csv = readFileSync((await (await download).path())!, "utf8");
  expect(csv).toContain('"ביאור 1 על בראשית","הסתיים"');
  expect(csv.trim().split(/\r\n/)).toHaveLength(BOOKS + 2);
  expect(csv).not.toContain('"נכשל"');
  expect(seen.external).toEqual([]);
  expect(seen.errors).toEqual([]);
});
